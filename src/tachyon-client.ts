import { Static } from "@sinclair/typebox";
import { Signal, SignalBinding } from "jaz-ts-utils";
import * as tls from "tls";
import * as gzip from "zlib";

import { clientCommandSchema } from "~/model/commands/client-commands";
import { serverCommandSchema } from "~/model/commands/server-commands";
import { NotConnectedError, ServerClosedError } from "~/model/errors";

export interface TachyonClientOptions extends tls.ConnectionOptions {
    host: string;
    port: number;
    verbose?: boolean;
    pingIntervalMs?: number;
}

export const defaultTachyonClientOptions: Partial<TachyonClientOptions> = {
    pingIntervalMs: 30000
};

export type ClientCommandType<T> = T extends keyof typeof clientCommandSchema ? Static<typeof clientCommandSchema[T]> : void;
export type ServerCommandType<T> = T extends keyof typeof serverCommandSchema ? Static<typeof serverCommandSchema[T]> : void;

// TODO: reduce the complexity and repeated information with this and the .addClientCommand calls using constraint identify functions
export interface TachyonClient {
    [key: string]: unknown;
    ping(): Promise<ServerCommandType<"s.system.pong">>;
    register(options: ClientCommandType<"c.auth.register">): Promise<ServerCommandType<"s.auth.register">>;
    getToken(options: ClientCommandType<"c.auth.get_token">): Promise<ServerCommandType<"s.auth.get_token">>;
    login(options: ClientCommandType<"c.auth.login">): Promise<ServerCommandType<"s.auth.login">>;
    verify(options: ClientCommandType<"c.auth.verify">): Promise<ServerCommandType<"s.auth.verify">>;
    disconnect(options: ClientCommandType<"c.auth.disconnect">): Promise<void>;
    getBattles(options: ClientCommandType<"c.lobby.query">): Promise<ServerCommandType<"s.lobby.query">>;
}

export class TachyonClient {
    public config: TachyonClientOptions;
    public socket?: tls.TLSSocket;
    public onClose = new Signal<void>();
    //public onCommand: Signal<{ [key: string]: unknown, cmd: string; }> = new Signal();

    protected pingIntervalId?: NodeJS.Timeout;
    protected requestSignals: Map<keyof typeof clientCommandSchema, Signal<unknown>> = new Map();
    protected responseSignals: Map<keyof typeof serverCommandSchema, Signal<unknown>> = new Map();
    protected requestClosedBinding?: SignalBinding;
    protected loggedIn = false;
    protected connected = false;

    constructor(options: TachyonClientOptions) {
        this.config = Object.assign({}, defaultTachyonClientOptions, options);

        if (options.rejectUnauthorized === undefined && this.config.host === "localhost") {
            this.config.rejectUnauthorized = false;
        }
    }

    public async connect() {
        return new Promise<void>((resolve, reject) => {
            if (this.socket && this.socket.readable) {
                resolve(); // already connected
                return;
            }

            this.requestSignals = new Map();
            this.responseSignals = new Map();
            
            this.addCommand("disconnect", "c.auth.disconnect");
            this.addCommand("ping", "c.system.ping", "s.system.pong");
            this.addCommand("register", "c.auth.register", "s.auth.register");
            this.addCommand("getToken", "c.auth.get_token", "s.auth.get_token");
            this.addCommand("login", "c.auth.login", "s.auth.login");
            this.addCommand("verify", "c.auth.verify", "s.auth.verify");
            this.addCommand("getBattles", "c.lobby.query", "s.lobby.query");

            this.socket = tls.connect(this.config);

            this.socket.on("data", (dataBuffer: Buffer) => {
                const data = dataBuffer.toString("utf8");
                const gzipped = Buffer.from(data, "base64");
                const response = gzip.unzipSync(gzipped);
                const jsonString = response.toString("utf8");
                const command = JSON.parse(jsonString);
                if (this.config.verbose) {
                    console.log("RESPONSE:", command);
                }

                const responseSignal = this.responseSignals.get(command.cmd);
                if (responseSignal) {
                    responseSignal.dispatch(command);
                }

                if (command.error || command.result === "error") {
                    reject(command);
                }
            });

            this.socket.on("secureConnect", () => {
                if (this.config.verbose) {
                    console.log(`connected to ${this.config.host}:${this.config.port}`);
                }
                this.connected = true;
                this.startPingInterval();
                resolve();
            });
            
            this.onClose.disposeAll();

            this.socket.on("close", () => {
                this.onClose.dispatch();
            });
            
            this.onClose.add(() => {
                this.loggedIn = false;
                this.stopPingInterval();
                this.socket?.destroy();
                if (this.config.verbose) {
                    console.log(`disconnected from ${this.config.host}:${this.config.port}`);
                }
                reject(new ServerClosedError());
            });

            this.socket.on("error", (err) => {
                if (this.config.verbose) {
                    console.error("error", err);
                }
                reject(err);
            });

            this.socket.on("timeout", (data) => {
                if (this.config.verbose) {
                    console.log("timeout", data);
                }
            });

            this.onResponse("s.auth.login").add((data) => {
                if (data.result === "success") {
                    this.loggedIn = true;
                }
            });

            this.onRequest("c.auth.disconnect").add(() => {
                this.loggedIn = false;
            });
        });
    }

    public onRequest<T extends keyof typeof clientCommandSchema>(type: T) : Signal<ClientCommandType<T>> {
        if (!this.requestSignals.has(type)) {
            this.requestSignals.set(type, new Signal());
        }
        return this.requestSignals.get(type) as Signal<ClientCommandType<T>>;
    }

    public onResponse<T extends keyof typeof serverCommandSchema>(type: T) : Signal<ServerCommandType<T>> {
        if (!this.responseSignals.has(type)) {
            this.responseSignals.set(type, new Signal());
        }
        return this.responseSignals.get(type) as Signal<ServerCommandType<T>>;
    }

    public isLoggedIn() {
        return this.loggedIn;
    }

    public isConnected() {
        return this.connected;
    }

    protected rawRequest(request: Record<string, unknown>) {
        const jsonString = JSON.stringify(request);
        const gzipped = gzip.gzipSync(jsonString);
        const base64 = Buffer.from(gzipped).toString("base64");

        if (this.config.verbose) {
            console.log("REQUEST:", request);
        }

        this.socket?.write(base64 + "\n");
    }

    protected addCommand<C extends keyof typeof clientCommandSchema, S extends keyof typeof serverCommandSchema, Args = Static<typeof clientCommandSchema[C]> extends Record<string, never> ? undefined : Static<typeof clientCommandSchema[C]>>(name: string, clientCmd: C, serverCmd?: S) {
        TachyonClient.prototype[name] = function(args?: Args) : Promise<ServerCommandType<S> | void> {
            return new Promise((resolve, reject) => {
                if (!this.socket?.readable) {
                    reject(new NotConnectedError());
                }

                if (this.requestClosedBinding) {
                    this.requestClosedBinding.destroy();
                }
                this.requestClosedBinding = this.onClose.add(() => {
                    if (clientCmd === "c.auth.disconnect") {
                        resolve();
                    } else {
                        reject(new ServerClosedError());
                    }
                });

                if (serverCmd) {
                    const signalBinding = this.onResponse(serverCmd).add((data) => {
                        signalBinding.destroy();
                        resolve(data);
                    });

                    this.rawRequest({ cmd: clientCmd, ...args });
                } else {
                    this.rawRequest({ cmd: clientCmd, ...args });

                    resolve();
                }
            });
        };
    }

    protected startPingInterval() {
        this.pingIntervalId = setInterval(() => {
            this.ping();
        }, this.config.pingIntervalMs);
    }

    protected stopPingInterval() {
        if (this.pingIntervalId) {
            clearInterval(this.pingIntervalId);
        }
    }
}