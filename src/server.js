import http from "http";
import app from "./app.js";
import { assertRequiredEnv, env } from "./config/env.js";
import { attachRealtimeServer } from "./realtime/realtime-server.js";

assertRequiredEnv();

const server = http.createServer(app);

attachRealtimeServer(server);

if (!process.env.VERCEL) {
  server.listen(env.port, () => {
    console.log(`Server listening on port ${env.port}`);
  });
}

export default app;
