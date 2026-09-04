# syntax=docker/dockerfile:1.7
FROM maven:3.9.9-eclipse-temurin-17 AS build
WORKDIR /build
COPY pom.xml ./
COPY src ./src
RUN --mount=type=cache,target=/root/.m2 mvn -B verify

FROM flink:1.20.1-scala_2.12-java17
COPY --from=build /build/target/flink-telemetry-job-0.1.0-all.jar /opt/flink/usrlib/flink-telemetry-job.jar
USER flink
