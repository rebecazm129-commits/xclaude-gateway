export type Severity = 'low' | 'medium' | 'high' | 'critical';

export type Category =
  | 'credential_detected'
  | 'prompt_injection'
  | 'email_send_warning'
  | 'data_export_warning'
  | 'tool_call_allowed'
  | 'pii_detected';

export interface DetectionFinding {
  type: string;
  location?: string;
}

export interface DetectionBlock {
  category: Category;
  severity: Severity;
  findings: DetectionFinding[];
}

export interface DetectionEvent {
  id: string;
  ts: string;
  session: string;
  mcp: string;
  type: 'mcp.request';
  method: string;
  detection: DetectionBlock;
}
