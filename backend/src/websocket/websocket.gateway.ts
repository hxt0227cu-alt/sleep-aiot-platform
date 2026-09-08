import {
  WebSocketGateway as NestWebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { IncomingMessage } from 'http';
import { Server, WebSocket } from 'ws';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  RealtimeFanoutService,
  FanoutEnvelope,
  resolveLocalBroadcast,
} from '../redis/realtime-fanout.service';

type WsClient = WebSocket & { url?: string };

@NestWebSocketGateway({
  path: 'ws',
  transports: ['websocket'],
  cors: { origin: '*' },
})
export class AppWebSocketGateway
  implements
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnModuleInit,
    OnModuleDestroy
{
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(AppWebSocketGateway.name);
  private readonly clients = new Map<string, WsClient>();
  private readonly userClients = new Map<string, Set<string>>();
  private readonly deviceClients = new Map<string, Set<string>>();
  private readonly heartbeats = new Map<string, number>();
  private heartbeatCheckInterval: NodeJS.Timeout | null = null;

  constructor(
    private jwtService: JwtService,
    private configService: ConfigService,
    private fanout: RealtimeFanoutService,
  ) {}

  onModuleInit() {
    this.logger.log('WebSocket Gateway initialized');
    this.startHeartbeatCheck();
    // 订阅跨副本扇出：任一副本发布的实时消息都会被本副本收到，并只投递给本副本
    // 本地持有的连接。客户端协议不变（ADR-014）。
    this.fanout
      .subscribe((env) => this.dispatchFanout(env))
      .catch((err) => {
        this.logger.error('Failed to subscribe realtime fanout', err);
      });
  }

  /**
   * 把跨副本扇出信封映射到本副本的本地投递。
   * 只投递给"连接在本副本"的客户端，因此每条消息在目标视角恰好一次。
   */
  private dispatchFanout(env: FanoutEnvelope): void {
    const broadcast = resolveLocalBroadcast(env);
    if (!broadcast) {
      return;
    }
    switch (broadcast.method) {
      case 'device':
        this.broadcastToDevice(broadcast.target as string, broadcast.message);
        break;
      case 'user':
        this.broadcastToUser(broadcast.target as string, broadcast.message);
        break;
      case 'all':
        this.broadcastToAll(broadcast.message);
        break;
    }
  }

  onModuleDestroy() {
    this.logger.log('WebSocket Gateway destroying');
    this.stopHeartbeatCheck();
  }

  async handleConnection(client: WsClient, request?: IncomingMessage) {
    const requestUrl = client.url || request?.url || '';
    this.logger.log(`Client connected: ${requestUrl || 'unknown'}`);

    const url = new URL(requestUrl, 'http://localhost');
    const token = url.searchParams.get('token');
    const deviceId = url.searchParams.get('device_id');

    if (!token) {
      this.logger.warn('Client connected without token');
      client.close(1008, 'Token required');
      return;
    }

    try {
      const payload = this.jwtService.verify(token, {
        secret: this.configService.get<string>('JWT_SECRET'),
      });

      const clientId = this.generateClientId();
      this.clients.set(clientId, client);

      if (payload.sub) {
        if (!this.userClients.has(payload.sub)) {
          this.userClients.set(payload.sub, new Set());
        }
        this.userClients.get(payload.sub)!.add(clientId);
      }

      if (deviceId) {
        if (!this.deviceClients.has(deviceId)) {
          this.deviceClients.set(deviceId, new Set());
        }
        this.deviceClients.get(deviceId)!.add(clientId);
      }

      this.heartbeats.set(clientId, Date.now());

      client.send(
        JSON.stringify({
          type: 'connected',
          clientId,
          timestamp: Date.now(),
        }),
      );

      this.logger.log(
        `Client authenticated: ${clientId}, userId: ${payload.sub}, deviceId: ${deviceId}`,
      );
    } catch (error) {
      this.logger.warn('Invalid token');
      client.close(1008, 'Invalid token');
    }
  }

  handleDisconnect(client: WsClient) {
    const clientId = this.findClientId(client);
    if (clientId) {
      this.clients.delete(clientId);
      this.heartbeats.delete(clientId);

      for (const [userId, clientSet] of this.userClients.entries()) {
        if (clientSet.has(clientId)) {
          clientSet.delete(clientId);
          if (clientSet.size === 0) {
            this.userClients.delete(userId);
          }
          break;
        }
      }

      for (const [deviceId, clientSet] of this.deviceClients.entries()) {
        if (clientSet.has(clientId)) {
          clientSet.delete(clientId);
          if (clientSet.size === 0) {
            this.deviceClients.delete(deviceId);
          }
          break;
        }
      }

      this.logger.log(`Client disconnected: ${clientId}`);
    }
  }

  @SubscribeMessage('heartbeat')
  handleHeartbeat(
    @ConnectedSocket() client: WsClient,
    @MessageBody() data: any,
  ) {
    const clientId = this.findClientId(client);
    if (clientId) {
      this.heartbeats.set(clientId, Date.now());
      client.send(
        JSON.stringify({
          type: 'heartbeat_ack',
          timestamp: Date.now(),
        }),
      );
    }
  }

  @SubscribeMessage('ping')
  handlePing(@ConnectedSocket() client: WsClient, @MessageBody() data: any) {
    const clientId = this.findClientId(client);
    if (clientId) {
      this.heartbeats.set(clientId, Date.now());
      client.send(
        JSON.stringify({
          type: 'pong',
          timestamp: data?.timestamp || Date.now(),
        }),
      );
    }
  }

  @SubscribeMessage('subscribe')
  handleSubscribe(
    @ConnectedSocket() client: WsClient,
    @MessageBody() data: any,
  ) {
    const clientId = this.findClientId(client);
    if (!clientId) return;

    const payload = data?.data ?? data ?? {};
    const deviceId = payload.deviceId || payload.device_id;
    const events =
      payload.events || payload.message_type || payload.messageType;

    if (deviceId) {
      if (!this.deviceClients.has(deviceId)) {
        this.deviceClients.set(deviceId, new Set());
      }
      this.deviceClients.get(deviceId)!.add(clientId);
    }

    client.send(
      JSON.stringify({
        type: 'subscribed',
        deviceId,
        events,
        timestamp: Date.now(),
      }),
    );
  }

  @SubscribeMessage('unsubscribe')
  handleUnsubscribe(
    @ConnectedSocket() client: WsClient,
    @MessageBody() data: any,
  ) {
    const clientId = this.findClientId(client);
    if (!clientId) return;

    const payload = data?.data ?? data ?? {};
    const deviceId = payload.deviceId || payload.device_id;

    if (deviceId && this.deviceClients.has(deviceId)) {
      this.deviceClients.get(deviceId)!.delete(clientId);
      if (this.deviceClients.get(deviceId)!.size === 0) {
        this.deviceClients.delete(deviceId);
      }
    }

    client.send(
      JSON.stringify({
        type: 'unsubscribed',
        deviceId,
        timestamp: Date.now(),
      }),
    );
  }

  broadcastToDevice(deviceId: string, message: any) {
    const clients = this.deviceClients.get(deviceId);
    if (clients) {
      const payload = JSON.stringify({
        type: message.type,
        deviceId,
        device_id: deviceId,
        data: message.data,
        timestamp: Date.now(),
      });

      clients.forEach((clientId) => {
        const client = this.clients.get(clientId);
        if (client && client.readyState === WebSocket.OPEN) {
          client.send(payload);
        }
      });
    }
  }

  broadcastToUser(userId: string, message: any) {
    const clients = this.userClients.get(userId);
    if (clients) {
      const payload = JSON.stringify({
        type: message.type,
        data: message.data,
        timestamp: Date.now(),
      });

      clients.forEach((clientId) => {
        const client = this.clients.get(clientId);
        if (client && client.readyState === WebSocket.OPEN) {
          client.send(payload);
        }
      });
    }
  }

  broadcastToAll(message: any) {
    const payload = JSON.stringify({
      type: message.type,
      data: message.data,
      timestamp: Date.now(),
    });

    this.clients.forEach((client, clientId) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    });
  }

  startHeartbeatCheck() {
    const HEARTBEAT_INTERVAL = 10000;
    const HEARTBEAT_TIMEOUT = 30000;

    this.heartbeatCheckInterval = setInterval(() => {
      const now = Date.now();
      const timedOutClients: string[] = [];

      this.heartbeats.forEach((lastHeartbeat, clientId) => {
        if (now - lastHeartbeat > HEARTBEAT_TIMEOUT) {
          timedOutClients.push(clientId);
        }
      });

      timedOutClients.forEach((clientId) => {
        const client = this.clients.get(clientId);
        if (client && client.readyState === WebSocket.OPEN) {
          this.logger.warn(`Client heartbeat timeout: ${clientId}`);
          client.close(1000, 'Heartbeat timeout');
        }
      });

      this.logger.debug(
        `Heartbeat check completed. Active clients: ${this.clients.size}`,
      );
    }, HEARTBEAT_INTERVAL);
  }

  stopHeartbeatCheck() {
    if (this.heartbeatCheckInterval) {
      clearInterval(this.heartbeatCheckInterval);
      this.heartbeatCheckInterval = null;
    }
  }

  getConnectedClientsCount(): number {
    return this.clients.size;
  }

  getConnectedUsersCount(): number {
    return this.userClients.size;
  }

  getConnectedDevicesCount(): number {
    return this.deviceClients.size;
  }

  isUserConnected(userId: string): boolean {
    const clients = this.userClients.get(userId);
    return clients ? clients.size > 0 : false;
  }

  isDeviceConnected(deviceId: string): boolean {
    const clients = this.deviceClients.get(deviceId);
    return clients ? clients.size > 0 : false;
  }

  private generateClientId(): string {
    return `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private findClientId(client: WsClient): string | undefined {
    for (const [clientId, c] of this.clients.entries()) {
      if (c === client) {
        return clientId;
      }
    }
    return undefined;
  }
}
