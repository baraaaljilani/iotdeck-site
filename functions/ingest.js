import { handle } from "../lib/core.js";
export const onRequest = ({ request, env }) => handle(request, env);
