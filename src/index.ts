const version: string = "0.1.0";

console.log("Task Management API");

export { version };
export { createApp, loadConfig, startServer, type RunningServer, type ServerConfig } from "./server.ts";
