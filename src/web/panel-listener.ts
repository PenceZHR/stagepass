import {
  createServer,
  type RequestListener,
  type Server,
} from "node:http";

export interface ReservedPanelListener {
  readonly server: Server;
  activate(listener: RequestListener): void;
}

const initializing: RequestListener = (_request, response) => {
  response.writeHead(503, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify({
    code: "stagepass_initializing",
    message: "StagePass is initializing",
  }));
};

/** Own the loopback socket before any persistent StagePass resource is opened. */
export async function reservePanelListener(input: {
  readonly port: number;
  readonly host?: string;
}): Promise<ReservedPanelListener> {
  let active: RequestListener = initializing;
  let activated = false;
  const server = createServer((request, response) => active(request, response));

  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error): void => { reject(error); };
    server.once("error", failed);
    server.listen(input.port, input.host ?? "127.0.0.1", () => {
      server.off("error", failed);
      resolve();
    });
  });

  return {
    server,
    activate(listener) {
      if (activated) throw new Error("panel_listener_already_active");
      activated = true;
      active = listener;
    },
  };
}
