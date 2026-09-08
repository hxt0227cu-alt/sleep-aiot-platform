package com.sleep.platform.telemetry;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.HashSet;
import java.util.Set;
import org.apache.flink.api.common.eventtime.WatermarkStrategy;
import org.apache.flink.api.common.functions.AggregateFunction;
import org.apache.flink.api.common.functions.OpenContext;
import org.apache.flink.api.common.serialization.SimpleStringSchema;
import org.apache.flink.api.common.state.StateTtlConfig;
import org.apache.flink.api.common.state.ValueState;
import org.apache.flink.api.common.state.ValueStateDescriptor;
import org.apache.flink.api.common.typeinfo.Types;
import org.apache.flink.configuration.CheckpointingOptions;
import org.apache.flink.configuration.Configuration;
import org.apache.flink.configuration.ExternalizedCheckpointRetention;
import org.apache.flink.configuration.RestartStrategyOptions;
import org.apache.flink.connector.base.DeliveryGuarantee;
import org.apache.flink.connector.kafka.sink.KafkaRecordSerializationSchema;
import org.apache.flink.connector.kafka.sink.KafkaSink;
import org.apache.flink.connector.kafka.source.KafkaSource;
import org.apache.flink.connector.kafka.source.enumerator.initializer.OffsetsInitializer;
import org.apache.flink.metrics.Counter;
import org.apache.flink.streaming.api.CheckpointingMode;
import org.apache.flink.streaming.api.datastream.DataStream;
import org.apache.flink.streaming.api.datastream.SingleOutputStreamOperator;
import org.apache.flink.streaming.api.environment.CheckpointConfig;
import org.apache.flink.streaming.api.environment.StreamExecutionEnvironment;
import org.apache.flink.streaming.api.functions.KeyedProcessFunction;
import org.apache.flink.streaming.api.functions.ProcessFunction;
import org.apache.flink.streaming.api.functions.windowing.ProcessWindowFunction;
import org.apache.flink.streaming.api.windowing.assigners.TumblingEventTimeWindows;
import org.apache.flink.streaming.api.windowing.windows.TimeWindow;
import org.apache.flink.util.Collector;
import org.apache.flink.util.OutputTag;
import org.apache.flink.util.ParameterTool;

public final class TelemetryStreamingJob {
  private static final ObjectMapper MAPPER = new ObjectMapper();
  static final OutputTag<String> INVALID_TAG = new OutputTag<String>("invalid-records") {};
  static final OutputTag<String> DUPLICATE_TAG = new OutputTag<String>("duplicate-records") {};
  static final OutputTag<String> LATE_TAG = new OutputTag<String>("late-records") {};

  private TelemetryStreamingJob() {}

  public static void main(String[] args) throws Exception {
    ParameterTool parameters = ParameterTool.fromArgs(args);
    String brokers = required(parameters, "bootstrap-servers");
    String sourceTopic = required(parameters, "source-topic");
    String runId = required(parameters, "run-id");
    int watermarkSeconds = parameters.getInt("watermark-seconds", 5);
    int windowMinutes = parameters.getInt("window-minutes", 1);
    long checkpointIntervalMs = parameters.getLong("checkpoint-interval-ms", 10_000L);
    if (checkpointIntervalMs < 1_000L) {
      throw new IllegalArgumentException("--checkpoint-interval-ms must be at least 1000");
    }

    StreamExecutionEnvironment environment = StreamExecutionEnvironment.getExecutionEnvironment();
    environment.setParallelism(parameters.getInt("parallelism", 1));
    // Flink 2.x：重启策略、外部化 checkpoint 与 checkpoint 存储统一走 Configuration
    // （setRestartStrategy / setGlobalJobParameters / setStateBackend /
    //  CheckpointConfig.setCheckpointStorage 已在 2.0 移除；hashmap 本就是默认状态后端）。
    Configuration configuration = new Configuration();
    configuration.set(RestartStrategyOptions.RESTART_STRATEGY, "fixed-delay");
    // 共享 CI runner 上 file:// checkpoint 偶发慢/超时：10 次重启 + 5s 间隔吸收瞬时抖动，
    // 避免 EXACTLY_ONCE sink 事务因短暂 checkpoint 失败而永久提交不了。
    configuration.set(RestartStrategyOptions.RESTART_STRATEGY_FIXED_DELAY_ATTEMPTS, 10);
    configuration.set(
        RestartStrategyOptions.RESTART_STRATEGY_FIXED_DELAY_DELAY, Duration.ofSeconds(5));
    configuration.set(
        CheckpointingOptions.EXTERNALIZED_CHECKPOINT_RETENTION,
        ExternalizedCheckpointRetention.RETAIN_ON_CANCELLATION);
    configuration.set(CheckpointingOptions.CHECKPOINT_STORAGE, "filesystem");
    configuration.set(
        CheckpointingOptions.CHECKPOINTS_DIRECTORY, required(parameters, "checkpoint-uri"));
    environment.configure(configuration);
    environment.enableCheckpointing(checkpointIntervalMs, CheckpointingMode.EXACTLY_ONCE);
    environment.getCheckpointConfig().setMinPauseBetweenCheckpoints(1_000);
    // 加载的 CI runner 上 checkpoint 写盘可能超过默认 60s：放宽到 180s。
    environment.getCheckpointConfig().setCheckpointTimeout(180_000);
    environment.getCheckpointConfig().setMaxConcurrentCheckpoints(1);

    KafkaSource<String> source = KafkaSource.<String>builder()
        .setBootstrapServers(brokers)
        .setTopics(sourceTopic)
        .setGroupId(required(parameters, "group-id"))
        .setStartingOffsets(OffsetsInitializer.earliest())
        .setValueOnlyDeserializer(new SimpleStringSchema())
        .setProperty("isolation.level", "read_committed")
        .build();

    DataStream<String> raw = environment.fromSource(
        source,
        WatermarkStrategy.noWatermarks(),
        "canonical-telemetry-source");

    SingleOutputStreamOperator<TelemetryEvent> parsed = raw
        .process(new ParseAndValidate(runId))
        .name("payload-validation");
    DataStream<String> invalid = parsed.getSideOutput(INVALID_TAG);

    SingleOutputStreamOperator<TelemetryEvent> timestamped = parsed
        .assignTimestampsAndWatermarks(
            WatermarkStrategy.<TelemetryEvent>forBoundedOutOfOrderness(Duration.ofSeconds(watermarkSeconds))
                .withTimestampAssigner((event, ignored) -> event.occurredAtMs)
                .withIdleness(Duration.ofSeconds(10)))
        .name("event-time-and-watermarks");

    SingleOutputStreamOperator<TelemetryEvent> deduplicated = timestamped
        .keyBy(event -> event.eventId)
        .process(new DeduplicateByEventId(runId))
        .name("event-id-deduplication");
    DataStream<String> duplicates = deduplicated.getSideOutput(DUPLICATE_TAG);

    SingleOutputStreamOperator<TelemetryEvent> onTime = deduplicated
        .process(new LateDataRouter(runId))
        .name("late-data-routing");
    DataStream<String> late = onTime.getSideOutput(LATE_TAG);

    DataStream<String> dwd = onTime
        .map(event -> dwdJson(runId, event))
        .returns(Types.STRING)
        .name("dwd-projection");

    DataStream<String> windowAggregates = onTime
        .keyBy(event -> event.tenantId)
        .window(TumblingEventTimeWindows.of(Duration.ofMinutes(windowMinutes)))
        .aggregate(new TenantWindowAggregate(), new TenantWindowResult(runId))
        .name("tenant-event-time-window");

    dwd.sinkTo(kafkaSink(brokers, required(parameters, "dwd-topic"), runId + "-dwd"))
        .name("dwd-kafka-sink");
    late.sinkTo(kafkaSink(brokers, required(parameters, "late-topic"), runId + "-late"))
        .name("late-kafka-sink");
    windowAggregates.sinkTo(kafkaSink(brokers, required(parameters, "aggregate-topic"), runId + "-aggregate"))
        .name("aggregate-kafka-sink");
    invalid.sinkTo(kafkaSink(brokers, required(parameters, "invalid-topic"), runId + "-invalid"))
        .name("invalid-kafka-sink");
    duplicates.sinkTo(kafkaSink(brokers, required(parameters, "duplicate-topic"), runId + "-duplicate"))
        .name("duplicate-kafka-sink");

    environment.execute("sleep-telemetry-event-time-" + runId);
  }

  static boolean isLate(long eventTimestamp, long currentWatermark) {
    return currentWatermark != Long.MIN_VALUE && eventTimestamp <= currentWatermark;
  }

  private static KafkaSink<String> kafkaSink(String brokers, String topic, String prefix) {
    return KafkaSink.<String>builder()
        .setBootstrapServers(brokers)
        .setRecordSerializer(
            KafkaRecordSerializationSchema.builder()
                .setTopic(topic)
                .setValueSerializationSchema(new SimpleStringSchema())
                .build())
        .setDeliveryGuarantee(DeliveryGuarantee.EXACTLY_ONCE)
        .setTransactionalIdPrefix("sleep-flink-" + prefix + "-")
        .setProperty("transaction.timeout.ms", "60000")
        .build();
  }

  private static String dwdJson(String runId, TelemetryEvent event) throws Exception {
    ObjectNode node = MAPPER.createObjectNode();
    node.put("run_id", runId);
    node.put("event_id", event.eventId);
    node.put("tenant_id", event.tenantId);
    node.put("device_id", event.deviceId);
    node.put("schema_version", event.schemaVersion);
    node.put("occurred_at_ms", event.occurredAtMs);
    node.put("received_at_ms", event.receivedAtMs);
    node.put("sequence", event.sequence);
    putNullable(node, "heart_rate", event.heartRate);
    putNullable(node, "breathing_rate", event.breathingRate);
    putNullable(node, "body_movement", event.bodyMovement);
    node.put("sleep_state", event.sleepState);
    putNullable(node, "confidence", event.confidence);
    node.put("processed_at_ms", System.currentTimeMillis());
    return MAPPER.writeValueAsString(node);
  }

  private static void putNullable(ObjectNode node, String name, Number value) {
    if (value == null) node.putNull(name);
    else if (value instanceof Integer) node.put(name, value.intValue());
    else node.put(name, value.doubleValue());
  }

  private static String required(ParameterTool parameters, String name) {
    if (!parameters.has(name) || parameters.get(name).isBlank()) {
      throw new IllegalArgumentException("--" + name + " is required");
    }
    return parameters.get(name);
  }

  static final class ParseAndValidate extends ProcessFunction<String, TelemetryEvent> {
    private final String runId;
    private transient Counter validCounter;
    private transient Counter invalidCounter;

    ParseAndValidate(String runId) {
      this.runId = runId;
    }

    @Override
    public void open(OpenContext openContext) {
      validCounter = getRuntimeContext().getMetricGroup().counter("valid_records_total");
      invalidCounter = getRuntimeContext().getMetricGroup().counter("invalid_records_total");
    }

    @Override
    public void processElement(String value, Context context, Collector<TelemetryEvent> output) throws Exception {
      try {
        output.collect(TelemetryParser.parse(value));
        validCounter.inc();
      } catch (TelemetryParser.ValidationException error) {
        invalidCounter.inc();
        ObjectNode rejected = MAPPER.createObjectNode();
        rejected.put("run_id", runId);
        rejected.put("error", error.getMessage());
        rejected.put("payload_bytes", value.getBytes(StandardCharsets.UTF_8).length);
        rejected.put("payload_sha256", sha256(value));
        rejected.put("rejected_at_ms", System.currentTimeMillis());
        context.output(INVALID_TAG, MAPPER.writeValueAsString(rejected));
      }
    }
  }

  static final class DeduplicateByEventId
      extends KeyedProcessFunction<String, TelemetryEvent, TelemetryEvent> {
    private final String runId;
    private transient ValueState<Boolean> seen;
    private transient Counter duplicateCounter;

    DeduplicateByEventId(String runId) {
      this.runId = runId;
    }

    @Override
    public void open(OpenContext openContext) {
      StateTtlConfig ttl = StateTtlConfig.newBuilder(Duration.ofHours(1))
          .setUpdateType(StateTtlConfig.UpdateType.OnCreateAndWrite)
          .setStateVisibility(StateTtlConfig.StateVisibility.NeverReturnExpired)
          .build();
      ValueStateDescriptor<Boolean> descriptor = new ValueStateDescriptor<>("seen-event-id", Boolean.class);
      descriptor.enableTimeToLive(ttl);
      seen = getRuntimeContext().getState(descriptor);
      duplicateCounter = getRuntimeContext().getMetricGroup().counter("duplicate_records_total");
    }

    @Override
    public void processElement(TelemetryEvent event, Context context, Collector<TelemetryEvent> output)
        throws Exception {
      if (Boolean.TRUE.equals(seen.value())) {
        duplicateCounter.inc();
        ObjectNode duplicate = MAPPER.createObjectNode();
        duplicate.put("run_id", runId);
        duplicate.put("event_id", event.eventId);
        duplicate.put("tenant_id", event.tenantId);
        duplicate.put("device_id", event.deviceId);
        duplicate.put("detected_at_ms", System.currentTimeMillis());
        context.output(DUPLICATE_TAG, MAPPER.writeValueAsString(duplicate));
        return;
      }
      seen.update(true);
      output.collect(event);
    }
  }

  static final class LateDataRouter extends ProcessFunction<TelemetryEvent, TelemetryEvent> {
    private final String runId;
    private transient Counter lateCounter;

    LateDataRouter(String runId) {
      this.runId = runId;
    }

    @Override
    public void open(OpenContext openContext) {
      lateCounter = getRuntimeContext().getMetricGroup().counter("late_records_total");
    }

    @Override
    public void processElement(TelemetryEvent event, Context context, Collector<TelemetryEvent> output)
        throws Exception {
      long watermark = context.timerService().currentWatermark();
      if (!isLate(event.occurredAtMs, watermark)) {
        output.collect(event);
        return;
      }
      lateCounter.inc();
      ObjectNode late = MAPPER.createObjectNode();
      late.put("run_id", runId);
      late.put("event_id", event.eventId);
      late.put("tenant_id", event.tenantId);
      late.put("device_id", event.deviceId);
      late.put("occurred_at_ms", event.occurredAtMs);
      late.put("received_at_ms", event.receivedAtMs);
      late.put("watermark_ms", watermark);
      late.put("lateness_ms", watermark - event.occurredAtMs);
      late.put("routed_at_ms", System.currentTimeMillis());
      context.output(LATE_TAG, MAPPER.writeValueAsString(late));
    }
  }

  public static final class WindowAccumulator {
    public long count;
    public long heartRateCount;
    public long breathingRateCount;
    public double heartRateSum;
    public double breathingRateSum;
    public Set<String> deviceIds = new HashSet<>();
  }

  static final class TenantWindowAggregate
      implements AggregateFunction<TelemetryEvent, WindowAccumulator, WindowAccumulator> {
    @Override
    public WindowAccumulator createAccumulator() {
      return new WindowAccumulator();
    }

    @Override
    public WindowAccumulator add(TelemetryEvent event, WindowAccumulator accumulator) {
      accumulator.count++;
      accumulator.deviceIds.add(event.deviceId);
      if (event.heartRate != null) {
        accumulator.heartRateSum += event.heartRate;
        accumulator.heartRateCount++;
      }
      if (event.breathingRate != null) {
        accumulator.breathingRateSum += event.breathingRate;
        accumulator.breathingRateCount++;
      }
      return accumulator;
    }

    @Override
    public WindowAccumulator getResult(WindowAccumulator accumulator) {
      return accumulator;
    }

    @Override
    public WindowAccumulator merge(WindowAccumulator left, WindowAccumulator right) {
      left.count += right.count;
      left.heartRateCount += right.heartRateCount;
      left.breathingRateCount += right.breathingRateCount;
      left.heartRateSum += right.heartRateSum;
      left.breathingRateSum += right.breathingRateSum;
      left.deviceIds.addAll(right.deviceIds);
      return left;
    }
  }

  static final class TenantWindowResult
      extends ProcessWindowFunction<WindowAccumulator, String, String, TimeWindow> {
    private final String runId;

    TenantWindowResult(String runId) {
      this.runId = runId;
    }

    @Override
    public void process(
        String tenantId,
        Context context,
        Iterable<WindowAccumulator> values,
        Collector<String> output) throws Exception {
      WindowAccumulator value = values.iterator().next();
      ObjectNode aggregate = MAPPER.createObjectNode();
      aggregate.put("run_id", runId);
      aggregate.put("tenant_id", tenantId);
      aggregate.put("window_start_ms", context.window().getStart());
      aggregate.put("window_end_ms", context.window().getEnd());
      aggregate.put("telemetry_events", value.count);
      aggregate.put("active_devices", value.deviceIds.size());
      if (value.heartRateCount == 0) aggregate.putNull("avg_heart_rate");
      else aggregate.put("avg_heart_rate", value.heartRateSum / value.heartRateCount);
      if (value.breathingRateCount == 0) aggregate.putNull("avg_breathing_rate");
      else aggregate.put("avg_breathing_rate", value.breathingRateSum / value.breathingRateCount);
      aggregate.put("emitted_at_ms", System.currentTimeMillis());
      output.collect(MAPPER.writeValueAsString(aggregate));
    }
  }

  private static String sha256(String value) throws Exception {
    byte[] digest = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
    StringBuilder result = new StringBuilder(digest.length * 2);
    for (byte item : digest) result.append(String.format("%02x", item));
    return result.toString();
  }
}
