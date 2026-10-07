import { afterEach } from "vitest";
import { closeOpened } from "./db.js";

// Each test's databases are closed when it ends, so a worker's memory does not grow with its file.
afterEach(closeOpened);
