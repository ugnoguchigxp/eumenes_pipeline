// Every `bun test` process starts with the reach guard: no network, no processes (bench/mock/guard.ts).
import { installGuard } from "./mock/guard.ts";

installGuard();
