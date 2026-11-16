import { d as defineEventHandler, a as deleteCookie } from '../../../nitro/nitro.mjs';
import 'node:http';
import 'node:https';
import 'node:events';
import 'node:buffer';
import 'node:fs';
import 'node:path';
import 'node:crypto';
import '@iconify/utils';
import 'consola';

const logout_post = defineEventHandler((event) => {
  deleteCookie(event, "app-auth", {
    path: "/",
    domain: process.env.COOKIE_DOMAIN || void 0
  });
  deleteCookie(event, "words-auth");
  return { success: true };
});

export { logout_post as default };
