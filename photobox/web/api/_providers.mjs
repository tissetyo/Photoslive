const PROVIDER_DEFINITIONS = Object.freeze({
  "cloudflare-r2": {
    kind: "storage",
    label: "Cloudflare R2",
    capability: "cloudStorage",
    adapterImplemented: true,
    requiredEnvironment: ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"],
  },
  "s3-compatible": {
    kind: "storage",
    label: "S3-compatible",
    capability: "cloudStorage",
    adapterImplemented: true,
    requiredEnvironment: ["S3_ENDPOINT", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_BUCKET"],
  },
  xendit: {
    kind: "payment",
    label: "Xendit QRIS",
    capability: "qris",
    adapterImplemented: true,
    requiredEnvironment: ["XENDIT_SECRET_KEY", "XENDIT_WEBHOOK_TOKEN"],
  },
  resend: {
    kind: "email",
    label: "Resend",
    capability: "email",
    adapterImplemented: true,
    requiredEnvironment: ["RESEND_API_KEY", "RESEND_FROM_EMAIL", "RESEND_WEBHOOK_SECRET"],
  },
  "custom-smtp": {
    kind: "email",
    label: "Custom SMTP",
    capability: "email",
    adapterImplemented: true,
    requiredEnvironment: ["SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_USERNAME", "SMTP_PASSWORD", "SMTP_FROM_EMAIL"],
  },
  "monitoring-webhook": {
    kind: "monitoring",
    label: "Monitoring webhook",
    capability: "monitoringAlert",
    adapterImplemented: true,
    requiredEnvironment: ["MONITORING_WEBHOOK_URL", "MONITORING_WEBHOOK_SECRET"],
  },
});

function configured(definition, environment) {
  return definition.requiredEnvironment.every(key => Boolean(environment[key]));
}

export function providerRegistry(environment = process.env) {
  return Object.entries(PROVIDER_DEFINITIONS).map(([id, definition]) => ({
    id,
    kind: definition.kind,
    label: definition.label,
    capability: definition.capability,
    adapterImplemented: definition.adapterImplemented,
    configured: configured(definition, environment),
    available: definition.adapterImplemented && configured(definition, environment),
    missingConfiguration: definition.requiredEnvironment.filter(key => !environment[key]),
  }));
}

export function deploymentCapabilities(environment = process.env) {
  const providers = providerRegistry(environment);
  const capability = (name, fallbackReason) => {
    const matches = providers.filter(provider => provider.capability === name);
    const available = matches.filter(provider => provider.available);
    return {
      available: available.length > 0,
      providers: available.map(provider => provider.id),
      configuredProviders: matches.filter(provider => provider.configured).map(provider => provider.id),
      reason: available.length ? null : fallbackReason,
    };
  };
  const cloudStorage = capability("cloudStorage", "Object storage belum dikonfigurasi; file kecil sementara memakai penyimpanan legacy.");
  return {
    qris: capability("qris", "Xendit QRIS belum dikonfigurasi untuk deployment atau booth ini."),
    cloudStorage,
    email: capability("email", "Resend atau Custom SMTP belum dikonfigurasi untuk deployment atau tenant ini."),
    monitoringAlert: capability("monitoringAlert", "Monitoring webhook belum dikonfigurasi."),
    sessionDownloads: { available: true, mode: cloudStorage.available ? "direct-object-storage" : "legacy-redis", maxFileBytes: cloudStorage.available ? 25_000_000 : 1_800_000, retentionHours: 24 },
    cloudAssets: { available: true, mode: cloudStorage.available ? "direct-object-storage" : "legacy-redis", maxFileBytes: cloudStorage.available ? 25_000_000 : 2_000_000 },
  };
}

export function providerDefinitions() {
  return structuredClone(PROVIDER_DEFINITIONS);
}
