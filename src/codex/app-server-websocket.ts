import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

import WebSocket, { type RawData } from "ws";

import {
  AppServerClient,
  type AppServerClientCallbacks,
  type AppServerProcessLike,
} from "./app-server-client";

export interface UnixAppServerOptions extends AppServerClientCallbacks {
  readonly socketPath: string;
  readonly socketFactory?: (socketPath: string) => AppServerWebSocket;
}

export interface AppServerWebSocket extends EventEmitter {
  send(data: string, callback?: (error?: Error) => void): void;
  close(): void;
  terminate(): void;
}

class WebSocketProcess extends EventEmitter implements AppServerProcessLike {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  private closed = false;

  constructor(private readonly socket: AppServerWebSocket) {
    super();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        const message = chunk.toString().replace(/\r?\n$/, "");
        this.socket.send(message, callback);
      },
      final: (callback) => {
        this.socket.close();
        callback();
      },
    });
    socket.on("message", (data: RawData) => {
      this.stdout.write(`${data.toString()}\n`);
    });
    socket.on("error", (error) => {
      this.stderr.write(error.message);
      this.emit("error", error);
    });
    socket.on("close", (code) => this.finish(code === 1_000 ? 0 : 1));
  }

  kill(): boolean {
    if (this.closed) return false;
    this.socket.terminate();
    return true;
  }

  private finish(code: number): void {
    if (this.closed) return;
    this.closed = true;
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code, null);
  }
}

function createUnixWebSocket(socketPath: string): AppServerWebSocket {
  return new WebSocket(`ws+unix://${socketPath}:/`, {
    headers: { Host: "localhost" },
    perMessageDeflate: false,
  });
}

function openUnixWebSocket(
  socketPath: string,
  factory: (socketPath: string) => AppServerWebSocket,
): Promise<AppServerWebSocket> {
  return new Promise((resolve, reject) => {
    const socket = factory(socketPath);
    const onError = (error: Error): void => {
      socket.removeListener("open", onOpen);
      reject(error);
    };
    const onOpen = (): void => {
      socket.removeListener("error", onError);
      resolve(socket);
    };
    socket.once("error", onError);
    socket.once("open", onOpen);
  });
}

export async function connectUnixAppServer(
  options: UnixAppServerOptions,
): Promise<AppServerClient> {
  const socket = await openUnixWebSocket(
    options.socketPath,
    options.socketFactory ?? createUnixWebSocket,
  );
  return AppServerClient.attach(new WebSocketProcess(socket), options);
}
