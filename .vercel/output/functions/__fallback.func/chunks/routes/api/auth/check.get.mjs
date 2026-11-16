import { d as defineEventHandler, g as getCookie, u as useRuntimeConfig } from '../../../nitro/nitro.mjs';
import 'node:http';
import 'node:https';
import 'node:events';
import 'node:buffer';
import 'node:fs';
import 'node:path';
import 'node:crypto';
import '@iconify/utils';
import 'consola';

const check_get = defineEventHandler((event) => {
  const config = useRuntimeConfig();
  const sharedAuth = getCookie(event, "app-auth");
  const appAuth = getCookie(event, "words-auth");
  const authenticated = sharedAuth && sharedAuth === config.authPassword || appAuth && appAuth === config.authPassword;
  return { authenticated: !!authenticated };
});

export { check_get as default };
