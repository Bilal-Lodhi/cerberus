class HealthStatus {
  /// ─── Cerberus AI — Health Check Model ─────────────────────────────────────
  /// Represents the connectivity heartbeat between the Flutter review panel,
  /// the Hono API gateway, the MCP server, and the MongoDB datastore.
  final String status; // "healthy" | "degraded" | "down"
  final String apiVersion;
  final int uptimeSeconds;
  final List<ServiceHealth> services;

  const HealthStatus({
    required this.status,
    required this.apiVersion,
    required this.uptimeSeconds,
    required this.services,
  });

  factory HealthStatus.fromJson(Map<String, dynamic> json) {
    final servicesRaw = json['services'] as List<dynamic>? ?? [];
    return HealthStatus(
      status: json['status'] as String? ?? 'unknown',
      apiVersion: json['api_version'] as String? ?? '0.0.0',
      uptimeSeconds: json['uptime_seconds'] as int? ?? 0,
      services: servicesRaw
          .map((s) => ServiceHealth.fromJson(s as Map<String, dynamic>))
          .toList(),
    );
  }

  bool get isHealthy => status == 'healthy';
}

class ServiceHealth {
  final String name; // "mongodb" | "gemini" | "mcp-server"
  final String status;
  final int latencyMs;

  const ServiceHealth({
    required this.name,
    required this.status,
    required this.latencyMs,
  });

  factory ServiceHealth.fromJson(Map<String, dynamic> json) {
    return ServiceHealth(
      name: json['name'] as String? ?? 'unknown',
      status: json['status'] as String? ?? 'unknown',
      latencyMs: json['latency_ms'] as int? ?? 0,
    );
  }

  bool get isHealthy => status == 'connected';
}
