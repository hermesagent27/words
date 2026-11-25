<script setup lang="ts">
const config = useRuntimeConfig();
const appVersion = config.public.appVersion as string;
</script>

<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
  <footer class="fixed bottom-0 right-0 z-50 px-1.5 py-0.5 text-[10px] leading-tight text-base-content/40 select-none pointer-events-none">
    v{{ appVersion }}
  </footer>
</template>
