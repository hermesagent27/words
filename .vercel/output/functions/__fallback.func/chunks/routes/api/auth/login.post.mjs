import { d as defineEventHandler, r as readBody, u as useRuntimeConfig, c as createError, s as setCookie } from '../../../nitro/nitro.mjs';
import 'node:http';
import 'node:https';
import 'node:events';
import 'node:buffer';
import 'node:fs';
import 'node:path';
import 'node:crypto';
import '@iconify/utils';
import 'consola';

const login_post = defineEventHandler(async (event) => {
  const { password } = await readBody(event);
  const config = useRuntimeConfig();
  if (password !== config.authPassword) {
    throw createError({
      statusCode: 401,
      statusMessage: "Invalid password"
    });
  }
  setCookie(event, "app-auth", password, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    domain: process.env.COOKIE_DOMAIN || void 0,
    maxAge: 60 * 60 * 24 * 7,
    // 7 days
    path: "/"
  });
  setCookie(event, "words-auth", password, {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    maxAge: 60 * 60 * 24 * 7
    // 7 days
  });
  return { success: true };
});

export { login_post as default };
