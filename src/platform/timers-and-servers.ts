import type http from "node:http";

export interface HttpServers {
  listen(server: http.Server, port: number, address: string): Promise<void>;
  close(server: http.Server): Promise<void>;
}

export interface IntervalTimers {
  setInterval(callback: () => void, milliseconds: number): unknown;
  clearInterval(handle: unknown): void;
}

export const nodeHttpServers: HttpServers = {
  async listen(server, port, address) {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, address, resolve);
    });
  },

  async close(server) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (
          !error ||
          (error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING"
        )
          resolve();
        else reject(error);
      });
      server.closeAllConnections();
    });
  },
};

export const nodeIntervalTimers: IntervalTimers = {
  setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
  clearInterval: (handle) =>
    clearInterval(handle as NodeJS.Timeout | undefined),
};
