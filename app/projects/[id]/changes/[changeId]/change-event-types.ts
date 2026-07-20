export interface EventItem {
  id: string;
  type: string;
  message: string | null;
  rawJson: string | null;
  createdAt: string;
}
