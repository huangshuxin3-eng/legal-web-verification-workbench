export type ProjectStatus = "active" | "completed";
export type TaskStatus =
  "not_started" | "in_progress" | "completed" | "blocked";
export type Project = {
  id: string;
  owner_id: string;
  name: string;
  code: string | null;
  status: ProjectStatus;
  created_at: string;
};
export type Task = {
  id: string;
  project_id: string;
  entity_name: string;
  topic: string;
  source_name: string;
  source_url: string;
  note: string | null;
  status: TaskStatus;
  created_at: string;
  completed_at: string | null;
  last_query_no: number;
};
export type Query = {
  id: string;
  task_id: string;
  query_no: number;
  query_text: string;
  created_at: string;
  last_capture_no: number;
  capture_operations: Record<
    string,
    Capture & { action: "upload" | "cancel" | "delete" }
  >;
};
export type Capture = {
  id: string;
  query_id: string;
  capture_no: number;
  storage_path: string;
  source_url: string | null;
  created_at: string;
};
type Table<
  Row,
  Required extends keyof Row,
  Relations extends {
    foreignKeyName: string;
    columns: string[];
    isOneToOne: boolean;
    referencedRelation: string;
    referencedColumns: string[];
  }[] = [],
> = {
  Row: Row;
  Insert: Pick<Row, Required> & Partial<Omit<Row, Required>>;
  Update: Partial<Row>;
  Relationships: Relations;
};
export type Database = {
  public: {
    Tables: {
      projects: Table<Project, "owner_id" | "name">;
      tasks: Table<
        Task,
        "project_id" | "entity_name" | "topic" | "source_name" | "source_url",
        [
          {
            foreignKeyName: "tasks_project_id_fkey";
            columns: ["project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
        ]
      >;
      queries: Table<
        Query,
        "task_id" | "query_text",
        [
          {
            foreignKeyName: "queries_task_id_fkey";
            columns: ["task_id"];
            isOneToOne: false;
            referencedRelation: "tasks";
            referencedColumns: ["id"];
          },
        ]
      >;
      captures: Table<
        Capture,
        "query_id" | "capture_no" | "storage_path",
        [
          {
            foreignKeyName: "captures_query_id_fkey";
            columns: ["query_id"];
            isOneToOne: false;
            referencedRelation: "queries";
            referencedColumns: ["id"];
          },
        ]
      >;
    };
    Views: Record<string, never>;
    Functions: {
      reserve_capture_upload: {
        Args: {
          p_query_id: string;
          p_source_url: string | null;
          p_extension: string;
          p_capture_id?: string;
        };
        Returns: Capture[];
      };
      finish_capture_upload: {
        Args: { p_query_id: string; p_capture_id: string };
        Returns: Capture[];
      };
      prepare_capture_delete: {
        Args: { p_capture_id: string };
        Returns: Capture[];
      };
      cancel_capture_upload: {
        Args: { p_query_id: string; p_capture_id: string };
        Returns: Capture[];
      };
      finish_capture_delete: {
        Args: { p_query_id: string; p_capture_id: string };
        Returns: boolean;
      };
      task_capture_counts: {
        Args: { p_project_id: string; p_task_id?: string };
        Returns: { task_id: string; capture_count: number }[];
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};
