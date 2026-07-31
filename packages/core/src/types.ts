/**
 * Hand-written types mirroring the migration in PLAN.md §4.
 *
 * Rules followed here, so future edits stay honest:
 * - Column names match the SQL exactly. Nothing renamed, nothing added.
 * - A column is `| null` unless the SQL says `not null` or it is the primary key.
 *   A `default` does NOT make a column non-nullable in Postgres — it only means
 *   the Insert type may omit it.
 * - The enum-ish columns are plain `text` in Postgres, but every one of them
 *   carries a CHECK constraint in the migration, so each union below mirrors a
 *   constraint the database also enforces:
 *     contacts.language / .source / .stage, interactions.direction / .channel,
 *     tasks.type / .status, agent_runs.trigger / .status.
 *   NULL passes a CHECK, which is why the columns stay nullable — a union is
 *   always `| null` unless the SQL says `not null`.
 *   Adding a value to a union without a matching
 *   `alter table … add constraint … check (…)` in the same change produces a
 *   type that compiles and a write that the database rejects at runtime.
 */

/** Postgres `jsonb`. */
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

// ---------------------------------------------------------------------------
// String-literal unions for the text columns that carry a fixed vocabulary
// ---------------------------------------------------------------------------

/** contacts.language — default 'el' */
export type Language = 'el' | 'en';

/** contacts.source */
export type Source = 'nfc_card' | 'referral' | 'inbound' | 'outbound' | 'walk_in';

/** contacts.stage — default 'new' */
export type Stage = 'new' | 'contacted' | 'replied' | 'quoted' | 'won' | 'lost' | 'dormant';

/** interactions.direction */
export type Direction = 'in' | 'out';

/** interactions.channel */
export type Channel = 'email' | 'phone' | 'in_person' | 'whatsapp' | 'form';

/** tasks.type */
export type TaskType = 'draft_email' | 'reminder' | 'alert';

/** tasks.status — default 'pending' */
export type TaskStatus = 'pending' | 'approved' | 'sent' | 'rejected' | 'skipped';

/** agent_runs.trigger */
export type AgentTrigger = 'cron' | 'webhook' | 'manual';

/** agent_runs.status */
export type AgentRunStatus = 'ok' | 'error';

/**
 * The autonomy ladder from SPEC §7. Stored as `int` in tasks.autonomy_level and
 * in settings.autonomy. Locked at 1 for v1.
 */
export type AutonomyLevel = 0 | 1 | 2 | 3;

// ---------------------------------------------------------------------------
// Database type, shaped for the @supabase/supabase-js generic parameter
// ---------------------------------------------------------------------------

export type Database = {
  public: {
    Tables: {
      brain: {
        Row: {
          key: string;
          value: string;
          updated_at: string | null;
        };
        Insert: {
          key: string;
          value: string;
          updated_at?: string | null;
        };
        Update: {
          key?: string;
          value?: string;
          updated_at?: string | null;
        };
        Relationships: [];
      };

      contacts: {
        Row: {
          id: string;
          name: string | null;
          business: string | null;
          email: string | null;
          phone: string | null;
          language: Language | null;
          city: string | null;
          country: string | null;
          timezone: string | null;
          source: Source | null;
          stage: Stage | null;
          value_estimate: number | null;
          notes: string | null;
          last_touch_at: string | null;
          next_touch_at: string | null;
          touch_count: number | null;
          do_not_contact: boolean | null;
          created_at: string | null;
        };
        Insert: {
          id?: string;
          name?: string | null;
          business?: string | null;
          email?: string | null;
          phone?: string | null;
          language?: Language | null;
          city?: string | null;
          country?: string | null;
          timezone?: string | null;
          source?: Source | null;
          stage?: Stage | null;
          value_estimate?: number | null;
          notes?: string | null;
          last_touch_at?: string | null;
          next_touch_at?: string | null;
          touch_count?: number | null;
          do_not_contact?: boolean | null;
          created_at?: string | null;
        };
        Update: {
          id?: string;
          name?: string | null;
          business?: string | null;
          email?: string | null;
          phone?: string | null;
          language?: Language | null;
          city?: string | null;
          country?: string | null;
          timezone?: string | null;
          source?: Source | null;
          stage?: Stage | null;
          value_estimate?: number | null;
          notes?: string | null;
          last_touch_at?: string | null;
          next_touch_at?: string | null;
          touch_count?: number | null;
          do_not_contact?: boolean | null;
          created_at?: string | null;
        };
        Relationships: [];
      };

      interactions: {
        Row: {
          id: string;
          contact_id: string | null;
          direction: Direction | null;
          channel: Channel | null;
          subject: string | null;
          body: string | null;
          occurred_at: string | null;
          meta: Json | null;
        };
        Insert: {
          id?: string;
          contact_id?: string | null;
          direction?: Direction | null;
          channel?: Channel | null;
          subject?: string | null;
          body?: string | null;
          occurred_at?: string | null;
          meta?: Json | null;
        };
        Update: {
          id?: string;
          contact_id?: string | null;
          direction?: Direction | null;
          channel?: Channel | null;
          subject?: string | null;
          body?: string | null;
          occurred_at?: string | null;
          meta?: Json | null;
        };
        Relationships: [
          {
            foreignKeyName: 'interactions_contact_id_fkey';
            columns: ['contact_id'];
            referencedRelation: 'contacts';
            referencedColumns: ['id'];
          },
        ];
      };

      tasks: {
        Row: {
          id: string;
          agent: string | null;
          type: TaskType | null;
          contact_id: string | null;
          title: string | null;
          reasoning: string | null;
          draft_subject: string | null;
          draft_body: string | null;
          final_body: string | null;
          status: TaskStatus | null;
          autonomy_level: number | null;
          send_after: string | null;
          created_at: string | null;
          resolved_at: string | null;
        };
        Insert: {
          id?: string;
          agent?: string | null;
          type?: TaskType | null;
          contact_id?: string | null;
          title?: string | null;
          reasoning?: string | null;
          draft_subject?: string | null;
          draft_body?: string | null;
          final_body?: string | null;
          status?: TaskStatus | null;
          autonomy_level?: number | null;
          send_after?: string | null;
          created_at?: string | null;
          resolved_at?: string | null;
        };
        Update: {
          id?: string;
          agent?: string | null;
          type?: TaskType | null;
          contact_id?: string | null;
          title?: string | null;
          reasoning?: string | null;
          draft_subject?: string | null;
          draft_body?: string | null;
          final_body?: string | null;
          status?: TaskStatus | null;
          autonomy_level?: number | null;
          send_after?: string | null;
          created_at?: string | null;
          resolved_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'tasks_contact_id_fkey';
            columns: ['contact_id'];
            referencedRelation: 'contacts';
            referencedColumns: ['id'];
          },
        ];
      };

      agent_runs: {
        Row: {
          id: string;
          agent: string | null;
          trigger: AgentTrigger | null;
          input: Json | null;
          output: Json | null;
          status: AgentRunStatus | null;
          error: string | null;
          model: string | null;
          input_tokens: number | null;
          output_tokens: number | null;
          cost_usd: number | null;
          duration_ms: number | null;
          created_at: string | null;
        };
        Insert: {
          id?: string;
          agent?: string | null;
          trigger?: AgentTrigger | null;
          input?: Json | null;
          output?: Json | null;
          status?: AgentRunStatus | null;
          error?: string | null;
          model?: string | null;
          input_tokens?: number | null;
          output_tokens?: number | null;
          cost_usd?: number | null;
          duration_ms?: number | null;
          created_at?: string | null;
        };
        Update: {
          id?: string;
          agent?: string | null;
          trigger?: AgentTrigger | null;
          input?: Json | null;
          output?: Json | null;
          status?: AgentRunStatus | null;
          error?: string | null;
          model?: string | null;
          input_tokens?: number | null;
          output_tokens?: number | null;
          cost_usd?: number | null;
          duration_ms?: number | null;
          created_at?: string | null;
        };
        Relationships: [];
      };

      settings: {
        Row: {
          key: string;
          value: Json;
          updated_at: string | null;
        };
        Insert: {
          key: string;
          value: Json;
          updated_at?: string | null;
        };
        Update: {
          key?: string;
          value?: Json;
          updated_at?: string | null;
        };
        Relationships: [];
      };

      push_subscriptions: {
        Row: {
          id: string;
          endpoint: string;
          keys: Json;
          created_at: string | null;
        };
        Insert: {
          id?: string;
          endpoint: string;
          keys: Json;
          created_at?: string | null;
        };
        Update: {
          id?: string;
          endpoint?: string;
          keys?: Json;
          created_at?: string | null;
        };
        Relationships: [];
      };
    };
    Views: Record<never, never>;
    Functions: Record<never, never>;
    Enums: Record<never, never>;
    CompositeTypes: Record<never, never>;
  };
};

// ---------------------------------------------------------------------------
// Convenience aliases
// ---------------------------------------------------------------------------

type Tables = Database['public']['Tables'];

export type BrainEntry = Tables['brain']['Row'];
export type Contact = Tables['contacts']['Row'];
export type Interaction = Tables['interactions']['Row'];
export type Task = Tables['tasks']['Row'];
export type AgentRun = Tables['agent_runs']['Row'];
export type Setting = Tables['settings']['Row'];
export type PushSubscription = Tables['push_subscriptions']['Row'];

export type BrainEntryInsert = Tables['brain']['Insert'];
export type ContactInsert = Tables['contacts']['Insert'];
export type InteractionInsert = Tables['interactions']['Insert'];
export type TaskInsert = Tables['tasks']['Insert'];
export type AgentRunInsert = Tables['agent_runs']['Insert'];
export type SettingInsert = Tables['settings']['Insert'];
export type PushSubscriptionInsert = Tables['push_subscriptions']['Insert'];

export type BrainEntryUpdate = Tables['brain']['Update'];
export type ContactUpdate = Tables['contacts']['Update'];
export type InteractionUpdate = Tables['interactions']['Update'];
export type TaskUpdate = Tables['tasks']['Update'];
export type AgentRunUpdate = Tables['agent_runs']['Update'];
export type SettingUpdate = Tables['settings']['Update'];
export type PushSubscriptionUpdate = Tables['push_subscriptions']['Update'];

/** The brain keys seeded in step 1 (PLAN.md §4). */
export const BRAIN_KEYS = [
  'services',
  'pricing',
  'tone_of_voice_en',
  'tone_of_voice_el',
  'case_studies',
  'positioning',
  'availability',
  'retainer_offer',
] as const;

export type BrainKey = (typeof BRAIN_KEYS)[number];
