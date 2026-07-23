import { backendHealth } from "./_backend_health.mjs";

const publicState = value => value === "ready" || value === "standby" ? "operational" : value === "error" ? "outage" : "limited";

export function publicStatusProjection(health, checkedAt = new Date().toISOString()) {
  const cacheState = publicState(health?.cache?.state);
  const storageProviders = Array.isArray(health?.providers) ? health.providers.filter(provider => provider.kind === "storage") : [];
  const activeStorage = storageProviders.find(provider => provider.state === "ready") || storageProviders.find(provider => provider.state === "error");
  const storageState = activeStorage ? publicState(activeStorage.state) : "limited";
  const components = [
    { id: "cloud-api", label: "Cloud API", state: "operational" },
    { id: "configuration", label: "Konfigurasi & voucher", state: cacheState },
    { id: "customer-assets", label: "Upload & hasil pelanggan", state: storageState },
  ];
  const overall = components.some(component => component.state === "outage")
    ? "outage"
    : components.some(component => component.state === "limited")
      ? "degraded"
      : "operational";
  return {
    checkedAt,
    overall,
    components,
    notice: overall === "operational"
      ? "Semua layanan cloud utama beroperasi normal."
      : overall === "degraded"
        ? "Layanan utama tetap tersedia, tetapi sebagian kemampuan sedang terbatas."
        : "Sebagian layanan cloud sedang terganggu. Booth lokal tetap dapat memakai mode offline yang tersedia.",
  };
}

export async function publicPlatformStatus(redis, options = {}) {
  const health = await (options.backendHealthImplementation || backendHealth)(redis, options);
  return publicStatusProjection(health, health.checkedAt);
}
