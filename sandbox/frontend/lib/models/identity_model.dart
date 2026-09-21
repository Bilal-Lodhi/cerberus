// ═══════════════════════════════════════════════════════════════════
// Cerberus FinSec — Identity Model
// ═══════════════════════════════════════════════════════════════════
// Lightweight identity types matching the Hono API identity endpoints
// for Employee/Operator UID management.

/// An employee (operator) identity record.
class OperatorIdentity {
  final String employeeId;
  final String displayName;
  final String department;
  final String role;
  final String clearanceLevel;

  const OperatorIdentity({
    required this.employeeId,
    required this.displayName,
    required this.department,
    required this.role,
    required this.clearanceLevel,
  });

  factory OperatorIdentity.fromJson(Map<String, dynamic> json) {
    return OperatorIdentity(
      employeeId: json['employeeId'] as String? ?? '',
      displayName: json['displayName'] as String? ?? '',
      department: json['department'] as String? ?? '',
      role: json['role'] as String? ?? '',
      clearanceLevel: json['clearanceLevel'] as String? ?? '',
    );
  }

  Map<String, dynamic> toJson() => {
    'employeeId': employeeId,
    'displayName': displayName,
    'department': department,
    'role': role,
    'clearanceLevel': clearanceLevel,
  };
}
