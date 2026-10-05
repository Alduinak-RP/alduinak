import * as promClient from "prom-client";
import { System, SystemContext } from "./system";

promClient.collectDefaultMetrics();

export const register = promClient.register;

export const connectsCounter = new promClient.Counter({
  name: "skymp_connects_total",
  help: "Total number of player connections",
});

export const disconnectsCounter = new promClient.Counter({
  name: "skymp_disconnects_total",
  help: "Total number of player disconnections",
});

export const loginsCounter = new promClient.Counter({
  name: "skymp_logins_total",
  help: "Total number of successful logins",
});

export const loginErrorsCounter = new promClient.Counter({
  name: "skymp_login_errors_total",
  help: "Total number of login errors",
  labelNames: ["reason"] as const,
});

export const cppMetricsErrorsCounter = new promClient.Counter({
  name: 'skymp_cpp_metrics_errors_total',
  help: 'Total number of errors during C++ metrics collection',
});

export const getAggregatedMetrics = async (scampServer?: any): Promise<string> => {
  const tsStart = performance.now();
  let metrics = '# === JS metrics begin ===\n' + await register.metrics() + '\n';
  const tsJsCollected = performance.now();

  try {
    const cppMetrics: string = scampServer?.getPrometheusMetrics() ?? "";
    metrics += '# === CPP metrics begin ===\n' + cppMetrics;
  } catch (err) {
    console.error("Failed to collect native metrics:", err);
    cppMetricsErrorsCounter.inc();
  }
  const tsCppCollected = performance.now();

  console.log('Metrics collection timings (ms):', Math.ceil(tsJsCollected - tsStart), Math.ceil(tsCppCollected - tsJsCollected));

  return metrics;
};

export class MetricsSystem implements System {
  systemName = "MetricsSystem";

  connect(_userId: number, _ctx: SystemContext): void {
    connectsCounter.inc();
  }

  disconnect(_userId: number, _ctx: SystemContext): void {
    disconnectsCounter.inc();
  }
}
