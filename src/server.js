import app from "./app.js";
import { assertRequiredEnv, env } from "./config/env.js";

assertRequiredEnv();

app.listen(env.port, () => {
  console.log(`Server listening on port ${env.port}`);
});
