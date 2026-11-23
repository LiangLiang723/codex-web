import "core-js/stable/array/to-sorted";
import "core-js/stable/array/to-reversed";
import "core-js/stable/object/group-by";
import { wireId } from "./gateway.js";
if (typeof crypto.randomUUID !== "function")
  Object.defineProperty(crypto, "randomUUID", { value: wireId });
