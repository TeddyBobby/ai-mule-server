import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Inject } from '@nestjs/common';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';

/**
 * WebSocket 网关
 * 处理实时通信
 */
@WebSocketGateway({
  cors: {
    origin: '*',
  },
})
export class AppWebSocketGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  constructor(
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {}

  afterInit(server: Server) {
    this.logger.info('WebSocket Gateway initialized', {
      context: 'WebSocketGateway',
    });
  }

  handleConnection(client: Socket) {
    this.logger.info(`Client connected: ${client.id}`, {
      context: 'WebSocketGateway',
    });
  }

  handleDisconnect(client: Socket) {
    this.logger.info(`Client disconnected: ${client.id}`, {
      context: 'WebSocketGateway',
    });
  }

  /**
   * 处理消息事件
   */
  @SubscribeMessage('message')
  handleMessage(
    @MessageBody() data: any,
    @ConnectedSocket() client: Socket,
  ): any {
    this.logger.info(`Message received from ${client.id}: ${JSON.stringify(data)}`, {
      context: 'WebSocketGateway',
    });

    // 回显消息
    return {
      event: 'message',
      data: {
        message: 'Message received',
        original: data,
      },
    };
  }

  /**
   * 广播消息给所有客户端
   */
  broadcastMessage(event: string, data: any) {
    this.server.emit(event, data);
    this.logger.info(`Broadcast message: ${event}`, {
      context: 'WebSocketGateway',
    });
  }

  /**
   * 发送消息给特定客户端
   */
  sendToClient(clientId: string, event: string, data: any) {
    this.server.to(clientId).emit(event, data);
    this.logger.info(`Message sent to ${clientId}: ${event}`, {
      context: 'WebSocketGateway',
    });
  }
}
