import { createApp } from "./app";
import { env } from "../config/env";

const app = createApp();

app.listen(env.port, () => {
  console.log(`transcript-agent backend listening on port ${env.port}`);
});
