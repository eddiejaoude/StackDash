
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "public": {
          Tables: {
            "access_invites": {
                  Row: {
                    "email": string,"invited_at": string,"invited_by": string
                  }
                  ComputedFields: never
                  Insert: {
                    "email": string,"invited_at"?: string,"invited_by": string
                  }
                  Update: {
                    "email"?: string,"invited_at"?: string,"invited_by"?: string
                  }
                  Relationships: [
                    
                  ]
                },"activity_event_daily_counts": {
                  Row: {
                    "day": string,"event_count": number,"external_account_id": string | null,"provider": Database["public"]['Enums']["provider_id"] | null,"type_id": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "day": string,"event_count": number,"external_account_id"?: string | null,"provider"?: Database["public"]['Enums']["provider_id"] | null,"type_id": string,"workspace_id": string
                  }
                  Update: {
                    "day"?: string,"event_count"?: number,"external_account_id"?: string | null,"provider"?: Database["public"]['Enums']["provider_id"] | null,"type_id"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "activity_event_daily_counts_workspace_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"activity_events": {
                  Row: {
                    "body": string | null,"connection_id": string | null,"created_at": string,"dedupe_key": string,"external_account_id": string | null,"id": string,"occurred_at": string,"provider": Database["public"]['Enums']["provider_id"] | null,"severity": Database["public"]['Enums']["event_severity"],"title": string,"type_id": string,"url": string | null,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "body"?: string | null,"connection_id"?: string | null,"created_at"?: string,"dedupe_key": string,"external_account_id"?: string | null,"id"?: string,"occurred_at": string,"provider"?: Database["public"]['Enums']["provider_id"] | null,"severity": Database["public"]['Enums']["event_severity"],"title": string,"type_id": string,"url"?: string | null,"workspace_id": string
                  }
                  Update: {
                    "body"?: string | null,"connection_id"?: string | null,"created_at"?: string,"dedupe_key"?: string,"external_account_id"?: string | null,"id"?: string,"occurred_at"?: string,"provider"?: Database["public"]['Enums']["provider_id"] | null,"severity"?: Database["public"]['Enums']["event_severity"],"title"?: string,"type_id"?: string,"url"?: string | null,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "activity_events_connection_fkey"
      columns: ["workspace_id","connection_id"]
isOneToOne: false
      referencedRelation: "connections"
      referencedColumns: ["workspace_id","id"]
    },{
      foreignKeyName: "activity_events_external_account_fkey"
      columns: ["workspace_id","external_account_id"]
isOneToOne: false
      referencedRelation: "external_accounts"
      referencedColumns: ["workspace_id","id"]
    },{
      foreignKeyName: "activity_events_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"alert_rule_destinations": {
                  Row: {
                    "destination_id": string,"rule_id": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "destination_id": string,"rule_id": string,"workspace_id": string
                  }
                  Update: {
                    "destination_id"?: string,"rule_id"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "alert_rule_destinations_destination_fkey"
      columns: ["workspace_id","destination_id"]
isOneToOne: false
      referencedRelation: "notification_destinations"
      referencedColumns: ["workspace_id","id"]
    },{
      foreignKeyName: "alert_rule_destinations_rule_fkey"
      columns: ["workspace_id","rule_id"]
isOneToOne: false
      referencedRelation: "alert_rules"
      referencedColumns: ["workspace_id","id"]
    }
                  ]
                },"alert_rules": {
                  Row: {
                    "budget_id": string | null,"connection_id": string | null,"created_at": string,"created_by": string | null,"currency": string | null,"id": string,"kind": Database["public"]['Enums']["alert_rule_kind"],"metric_key": string | null,"paused": boolean,"project_id": string | null,"provider": Database["public"]['Enums']["provider_id"] | null,"scope": Database["public"]['Enums']["alert_scope"],"threshold_amount_minor": number | null,"threshold_percent": number | null,"updated_at": string,"updated_by": string | null,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "budget_id"?: string | null,"connection_id"?: string | null,"created_at"?: string,"created_by"?: string | null,"currency"?: string | null,"id"?: string,"kind": Database["public"]['Enums']["alert_rule_kind"],"metric_key"?: string | null,"paused"?: boolean,"project_id"?: string | null,"provider"?: Database["public"]['Enums']["provider_id"] | null,"scope": Database["public"]['Enums']["alert_scope"],"threshold_amount_minor"?: number | null,"threshold_percent"?: number | null,"updated_at"?: string,"updated_by"?: string | null,"workspace_id": string
                  }
                  Update: {
                    "budget_id"?: string | null,"connection_id"?: string | null,"created_at"?: string,"created_by"?: string | null,"currency"?: string | null,"id"?: string,"kind"?: Database["public"]['Enums']["alert_rule_kind"],"metric_key"?: string | null,"paused"?: boolean,"project_id"?: string | null,"provider"?: Database["public"]['Enums']["provider_id"] | null,"scope"?: Database["public"]['Enums']["alert_scope"],"threshold_amount_minor"?: number | null,"threshold_percent"?: number | null,"updated_at"?: string,"updated_by"?: string | null,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "alert_rules_budget_fkey"
      columns: ["workspace_id","budget_id"]
isOneToOne: false
      referencedRelation: "budgets"
      referencedColumns: ["workspace_id","id"]
    },{
      foreignKeyName: "alert_rules_connection_fkey"
      columns: ["workspace_id","connection_id"]
isOneToOne: false
      referencedRelation: "connections"
      referencedColumns: ["workspace_id","id"]
    },{
      foreignKeyName: "alert_rules_project_fkey"
      columns: ["workspace_id","project_id"]
isOneToOne: false
      referencedRelation: "projects"
      referencedColumns: ["workspace_id","id"]
    },{
      foreignKeyName: "alert_rules_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"anomaly_mutes": {
                  Row: {
                    "created_at": string,"created_by": string | null,"id": string,"metric_key": string,"provider": Database["public"]['Enums']["provider_id"],"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"id"?: string,"metric_key": string,"provider": Database["public"]['Enums']["provider_id"],"workspace_id": string
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"id"?: string,"metric_key"?: string,"provider"?: Database["public"]['Enums']["provider_id"],"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "anomaly_mutes_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"api_key_request_windows": {
                  Row: {
                    "key_id": string,"request_count": number,"window_start": string
                  }
                  ComputedFields: never
                  Insert: {
                    "key_id": string,"request_count"?: number,"window_start": string
                  }
                  Update: {
                    "key_id"?: string,"request_count"?: number,"window_start"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "api_key_request_windows_key_id_fkey"
      columns: ["key_id"]
isOneToOne: false
      referencedRelation: "api_keys"
      referencedColumns: ["id"]
    }
                  ]
                },"api_keys": {
                  Row: {
                    "created_at": string,"created_by": string | null,"id": string,"last_used_at": string | null,"name": string,"revoked_at": string | null,"revoked_by": string | null,"scopes": (Database["public"]['Enums']["api_key_scope"])[],"token_hash": string,"token_prefix": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"id"?: string,"last_used_at"?: string | null,"name": string,"revoked_at"?: string | null,"revoked_by"?: string | null,"scopes": (Database["public"]['Enums']["api_key_scope"])[],"token_hash": string,"token_prefix": string,"workspace_id": string
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"id"?: string,"last_used_at"?: string | null,"name"?: string,"revoked_at"?: string | null,"revoked_by"?: string | null,"scopes"?: (Database["public"]['Enums']["api_key_scope"])[],"token_hash"?: string,"token_prefix"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "api_keys_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"budgets": {
                  Row: {
                    "amount_minor": number,"connection_id": string | null,"created_at": string,"created_by": string | null,"currency": string,"id": string,"name": string,"period": string,"project_id": string | null,"provider": Database["public"]['Enums']["provider_id"] | null,"scope": Database["public"]['Enums']["alert_scope"],"updated_at": string,"updated_by": string | null,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "amount_minor": number,"connection_id"?: string | null,"created_at"?: string,"created_by"?: string | null,"currency": string,"id"?: string,"name": string,"period"?: string,"project_id"?: string | null,"provider"?: Database["public"]['Enums']["provider_id"] | null,"scope": Database["public"]['Enums']["alert_scope"],"updated_at"?: string,"updated_by"?: string | null,"workspace_id": string
                  }
                  Update: {
                    "amount_minor"?: number,"connection_id"?: string | null,"created_at"?: string,"created_by"?: string | null,"currency"?: string,"id"?: string,"name"?: string,"period"?: string,"project_id"?: string | null,"provider"?: Database["public"]['Enums']["provider_id"] | null,"scope"?: Database["public"]['Enums']["alert_scope"],"updated_at"?: string,"updated_by"?: string | null,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "budgets_connection_fkey"
      columns: ["workspace_id","connection_id"]
isOneToOne: false
      referencedRelation: "connections"
      referencedColumns: ["workspace_id","id"]
    },{
      foreignKeyName: "budgets_project_fkey"
      columns: ["workspace_id","project_id"]
isOneToOne: false
      referencedRelation: "projects"
      referencedColumns: ["workspace_id","id"]
    },{
      foreignKeyName: "budgets_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"connection_credentials": {
                  Row: {
                    "auth_tag": string,"ciphertext": string,"connection_id": string,"iv": string,"key_id": string,"updated_at": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "auth_tag": string,"ciphertext": string,"connection_id": string,"iv": string,"key_id": string,"updated_at"?: string,"workspace_id": string
                  }
                  Update: {
                    "auth_tag"?: string,"ciphertext"?: string,"connection_id"?: string,"iv"?: string,"key_id"?: string,"updated_at"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "connection_credentials_connection_fkey"
      columns: ["workspace_id","connection_id"]
isOneToOne: false
      referencedRelation: "connections"
      referencedColumns: ["workspace_id","id"]
    },{
      foreignKeyName: "connection_credentials_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"connections": {
                  Row: {
                    "authorized_account_label": string | null,"consecutive_failures": number,"created_at": string,"created_by": string | null,"display_name": string,"external_installation_id": string | null,"granted_at": string | null,"granted_scopes": (string)[],"id": string,"last_error_code": string | null,"last_error_reference": string | null,"last_sync_requested_at": string | null,"last_synced_at": string | null,"missing_scopes": (string)[],"mode": Database["public"]['Enums']["connection_mode"] | null,"next_sync_at": string | null,"poll_interval_seconds": number,"provider": Database["public"]['Enums']["provider_id"],"status": Database["public"]['Enums']["connection_status"],"updated_at": string,"updated_by": string | null,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "authorized_account_label"?: string | null,"consecutive_failures"?: number,"created_at"?: string,"created_by"?: string | null,"display_name": string,"external_installation_id"?: string | null,"granted_at"?: string | null,"granted_scopes"?: (string)[],"id"?: string,"last_error_code"?: string | null,"last_error_reference"?: string | null,"last_sync_requested_at"?: string | null,"last_synced_at"?: string | null,"missing_scopes"?: (string)[],"mode"?: Database["public"]['Enums']["connection_mode"] | null,"next_sync_at"?: string | null,"poll_interval_seconds": number,"provider": Database["public"]['Enums']["provider_id"],"status"?: Database["public"]['Enums']["connection_status"],"updated_at"?: string,"updated_by"?: string | null,"workspace_id": string
                  }
                  Update: {
                    "authorized_account_label"?: string | null,"consecutive_failures"?: number,"created_at"?: string,"created_by"?: string | null,"display_name"?: string,"external_installation_id"?: string | null,"granted_at"?: string | null,"granted_scopes"?: (string)[],"id"?: string,"last_error_code"?: string | null,"last_error_reference"?: string | null,"last_sync_requested_at"?: string | null,"last_synced_at"?: string | null,"missing_scopes"?: (string)[],"mode"?: Database["public"]['Enums']["connection_mode"] | null,"next_sync_at"?: string | null,"poll_interval_seconds"?: number,"provider"?: Database["public"]['Enums']["provider_id"],"status"?: Database["public"]['Enums']["connection_status"],"updated_at"?: string,"updated_by"?: string | null,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "connections_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"credential_refresh_locks": {
                  Row: {
                    "connection_id": string,"lock_id": string,"locked_until": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "connection_id": string,"lock_id": string,"locked_until": string,"workspace_id": string
                  }
                  Update: {
                    "connection_id"?: string,"lock_id"?: string,"locked_until"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "credential_refresh_locks_connection_fkey"
      columns: ["workspace_id","connection_id"]
isOneToOne: false
      referencedRelation: "connections"
      referencedColumns: ["workspace_id","id"]
    }
                  ]
                },"external_accounts": {
                  Row: {
                    "connection_id": string,"created_at": string,"display_name": string,"external_id": string,"id": string,"included": boolean,"kind": string,"project_id": string | null,"sync_cursor": string | null,"updated_at": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "connection_id": string,"created_at"?: string,"display_name": string,"external_id": string,"id"?: string,"included"?: boolean,"kind": string,"project_id"?: string | null,"sync_cursor"?: string | null,"updated_at"?: string,"workspace_id": string
                  }
                  Update: {
                    "connection_id"?: string,"created_at"?: string,"display_name"?: string,"external_id"?: string,"id"?: string,"included"?: boolean,"kind"?: string,"project_id"?: string | null,"sync_cursor"?: string | null,"updated_at"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "external_accounts_connection_fkey"
      columns: ["workspace_id","connection_id"]
isOneToOne: false
      referencedRelation: "connections"
      referencedColumns: ["workspace_id","id"]
    },{
      foreignKeyName: "external_accounts_project_fkey"
      columns: ["workspace_id","project_id"]
isOneToOne: false
      referencedRelation: "projects"
      referencedColumns: ["workspace_id","id"]
    },{
      foreignKeyName: "external_accounts_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"notification_deliveries": {
                  Row: {
                    "delivered_at": string,"destination_id": string | null,"id": string,"subject_key": string,"target_key": string,"triggered_alert_id": string | null,"user_id": string | null,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "delivered_at"?: string,"destination_id"?: string | null,"id"?: string,"subject_key": string,"target_key": string,"triggered_alert_id"?: string | null,"user_id"?: string | null,"workspace_id": string
                  }
                  Update: {
                    "delivered_at"?: string,"destination_id"?: string | null,"id"?: string,"subject_key"?: string,"target_key"?: string,"triggered_alert_id"?: string | null,"user_id"?: string | null,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "notification_deliveries_destination_fkey"
      columns: ["workspace_id","destination_id"]
isOneToOne: false
      referencedRelation: "notification_destinations"
      referencedColumns: ["workspace_id","id"]
    },{
      foreignKeyName: "notification_deliveries_triggered_alert_id_fkey"
      columns: ["triggered_alert_id"]
isOneToOne: false
      referencedRelation: "triggered_alerts"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "notification_deliveries_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"notification_destination_secrets": {
                  Row: {
                    "auth_tag": string,"ciphertext": string,"destination_id": string,"iv": string,"key_id": string,"updated_at": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "auth_tag": string,"ciphertext": string,"destination_id": string,"iv": string,"key_id": string,"updated_at"?: string,"workspace_id": string
                  }
                  Update: {
                    "auth_tag"?: string,"ciphertext"?: string,"destination_id"?: string,"iv"?: string,"key_id"?: string,"updated_at"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "notification_destination_secrets_destination_fkey"
      columns: ["workspace_id","destination_id"]
isOneToOne: false
      referencedRelation: "notification_destinations"
      referencedColumns: ["workspace_id","id"]
    },{
      foreignKeyName: "notification_destination_secrets_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"notification_destinations": {
                  Row: {
                    "all_rules": boolean,"consecutive_failures": number,"created_at": string,"created_by": string | null,"digest": Database["public"]['Enums']["digest_frequency"],"id": string,"kind": Database["public"]['Enums']["destination_kind"],"last_delivered_at": string | null,"last_error_code": string | null,"last_error_reference": string | null,"name": string,"status": Database["public"]['Enums']["destination_status"],"updated_at": string,"updated_by": string | null,"url_host": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "all_rules"?: boolean,"consecutive_failures"?: number,"created_at"?: string,"created_by"?: string | null,"digest"?: Database["public"]['Enums']["digest_frequency"],"id"?: string,"kind": Database["public"]['Enums']["destination_kind"],"last_delivered_at"?: string | null,"last_error_code"?: string | null,"last_error_reference"?: string | null,"name": string,"status"?: Database["public"]['Enums']["destination_status"],"updated_at"?: string,"updated_by"?: string | null,"url_host": string,"workspace_id": string
                  }
                  Update: {
                    "all_rules"?: boolean,"consecutive_failures"?: number,"created_at"?: string,"created_by"?: string | null,"digest"?: Database["public"]['Enums']["digest_frequency"],"id"?: string,"kind"?: Database["public"]['Enums']["destination_kind"],"last_delivered_at"?: string | null,"last_error_code"?: string | null,"last_error_reference"?: string | null,"name"?: string,"status"?: Database["public"]['Enums']["destination_status"],"updated_at"?: string,"updated_by"?: string | null,"url_host"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "notification_destinations_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"notification_preferences": {
                  Row: {
                    "email_frequency": Database["public"]['Enums']["email_frequency"],"updated_at": string,"user_id": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "email_frequency": Database["public"]['Enums']["email_frequency"],"updated_at"?: string,"user_id": string,"workspace_id": string
                  }
                  Update: {
                    "email_frequency"?: Database["public"]['Enums']["email_frequency"],"updated_at"?: string,"user_id"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "notification_preferences_member_fkey"
      columns: ["workspace_id","user_id"]
isOneToOne: true
      referencedRelation: "workspace_members"
      referencedColumns: ["workspace_id","user_id"]
    }
                  ]
                },"oauth_states": {
                  Row: {
                    "code_verifier_ciphertext": string | null,"code_verifier_iv": string | null,"code_verifier_tag": string | null,"created_at": string,"expires_at": string,"key_id": string | null,"pending_installation_id": string | null,"provider": Database["public"]['Enums']["provider_id"],"reconnect_connection_id": string | null,"state": string,"user_id": string,"webhook_setup": boolean,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "code_verifier_ciphertext"?: string | null,"code_verifier_iv"?: string | null,"code_verifier_tag"?: string | null,"created_at"?: string,"expires_at": string,"key_id"?: string | null,"pending_installation_id"?: string | null,"provider": Database["public"]['Enums']["provider_id"],"reconnect_connection_id"?: string | null,"state": string,"user_id": string,"webhook_setup"?: boolean,"workspace_id": string
                  }
                  Update: {
                    "code_verifier_ciphertext"?: string | null,"code_verifier_iv"?: string | null,"code_verifier_tag"?: string | null,"created_at"?: string,"expires_at"?: string,"key_id"?: string | null,"pending_installation_id"?: string | null,"provider"?: Database["public"]['Enums']["provider_id"],"reconnect_connection_id"?: string | null,"state"?: string,"user_id"?: string,"webhook_setup"?: boolean,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "oauth_states_reconnect_connection_fkey"
      columns: ["workspace_id","reconnect_connection_id"]
isOneToOne: false
      referencedRelation: "connections"
      referencedColumns: ["workspace_id","id"]
    },{
      foreignKeyName: "oauth_states_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"profiles": {
                  Row: {
                    "avatar_url": string | null,"created_at": string,"display_name": string | null,"last_workspace_id": string | null,"updated_at": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "avatar_url"?: string | null,"created_at"?: string,"display_name"?: string | null,"last_workspace_id"?: string | null,"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "avatar_url"?: string | null,"created_at"?: string,"display_name"?: string | null,"last_workspace_id"?: string | null,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "profiles_last_workspace_id_fkey"
      columns: ["last_workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"project_achievement_publications": {
                  Row: {
                    "project_achievement_id": string,"published_at": string,"published_by": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "project_achievement_id": string,"published_at"?: string,"published_by": string,"workspace_id": string
                  }
                  Update: {
                    "project_achievement_id"?: string,"published_at"?: string,"published_by"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "project_achievement_publications_achievement_fkey"
      columns: ["workspace_id","project_achievement_id"]
isOneToOne: false
      referencedRelation: "project_achievements"
      referencedColumns: ["workspace_id","id"]
    },{
      foreignKeyName: "project_achievement_publications_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"project_achievements": {
                  Row: {
                    "achievement_id": string,"created_at": string,"description": string,"earned_at": string,"earned_precision": Database["public"]['Enums']["achievement_date_precision"],"evidence": Database["public"]['Enums']["achievement_evidence"],"id": string,"project_id": string,"provider": Database["public"]['Enums']["provider_id"],"public_title": string,"simulated": boolean,"threshold": number | null,"title": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "achievement_id": string,"created_at"?: string,"description": string,"earned_at": string,"earned_precision": Database["public"]['Enums']["achievement_date_precision"],"evidence": Database["public"]['Enums']["achievement_evidence"],"id"?: string,"project_id": string,"provider": Database["public"]['Enums']["provider_id"],"public_title": string,"simulated"?: boolean,"threshold"?: number | null,"title": string,"workspace_id": string
                  }
                  Update: {
                    "achievement_id"?: string,"created_at"?: string,"description"?: string,"earned_at"?: string,"earned_precision"?: Database["public"]['Enums']["achievement_date_precision"],"evidence"?: Database["public"]['Enums']["achievement_evidence"],"id"?: string,"project_id"?: string,"provider"?: Database["public"]['Enums']["provider_id"],"public_title"?: string,"simulated"?: boolean,"threshold"?: number | null,"title"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "project_achievements_project_fkey"
      columns: ["workspace_id","project_id"]
isOneToOne: false
      referencedRelation: "projects"
      referencedColumns: ["workspace_id","id"]
    },{
      foreignKeyName: "project_achievements_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"project_pages": {
                  Row: {
                    "created_at": string,"enabled": boolean,"indexable": boolean,"project_id": string,"slug": string,"updated_at": string,"updated_by": string | null,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"enabled"?: boolean,"indexable"?: boolean,"project_id": string,"slug": string,"updated_at"?: string,"updated_by"?: string | null,"workspace_id": string
                  }
                  Update: {
                    "created_at"?: string,"enabled"?: boolean,"indexable"?: boolean,"project_id"?: string,"slug"?: string,"updated_at"?: string,"updated_by"?: string | null,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "project_pages_project_fkey"
      columns: ["workspace_id","project_id"]
isOneToOne: false
      referencedRelation: "projects"
      referencedColumns: ["workspace_id","id"]
    },{
      foreignKeyName: "project_pages_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"projects": {
                  Row: {
                    "created_at": string,"created_by": string | null,"id": string,"name": string,"updated_at": string,"updated_by": string | null,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"id"?: string,"name": string,"updated_at"?: string,"updated_by"?: string | null,"workspace_id": string
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"id"?: string,"name"?: string,"updated_at"?: string,"updated_by"?: string | null,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "projects_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"public_rate_limit_counters": {
                  Row: {
                    "count": number,"ip_hash": string,"window_start": string
                  }
                  ComputedFields: never
                  Insert: {
                    "count"?: number,"ip_hash": string,"window_start": string
                  }
                  Update: {
                    "count"?: number,"ip_hash"?: string,"window_start"?: string
                  }
                  Relationships: [
                    
                  ]
                },"published_metric_views": {
                  Row: {
                    "metric_id": Database["public"]['Enums']["public_metric_id"],"project_id": string,"surface": Database["public"]['Enums']["share_surface"],"view_date": string,"views": number,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "metric_id": Database["public"]['Enums']["public_metric_id"],"project_id": string,"surface": Database["public"]['Enums']["share_surface"],"view_date": string,"views"?: number,"workspace_id": string
                  }
                  Update: {
                    "metric_id"?: Database["public"]['Enums']["public_metric_id"],"project_id"?: string,"surface"?: Database["public"]['Enums']["share_surface"],"view_date"?: string,"views"?: number,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "published_metric_views_project_fkey"
      columns: ["workspace_id","project_id"]
isOneToOne: false
      referencedRelation: "projects"
      referencedColumns: ["workspace_id","id"]
    },{
      foreignKeyName: "published_metric_views_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"published_metrics": {
                  Row: {
                    "delay_days": number,"id": string,"metric_id": Database["public"]['Enums']["public_metric_id"] | null,"project_id": string,"published_at": string,"published_by": string,"revoked_at": string | null,"revoked_by": string | null,"rounding": Database["public"]['Enums']["published_metric_rounding"],"self_reported_label": string | null,"self_reported_unit": string | null,"self_reported_value": number | null,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "delay_days"?: number,"id"?: string,"metric_id"?: Database["public"]['Enums']["public_metric_id"] | null,"project_id": string,"published_at"?: string,"published_by": string,"revoked_at"?: string | null,"revoked_by"?: string | null,"rounding"?: Database["public"]['Enums']["published_metric_rounding"],"self_reported_label"?: string | null,"self_reported_unit"?: string | null,"self_reported_value"?: number | null,"workspace_id": string
                  }
                  Update: {
                    "delay_days"?: number,"id"?: string,"metric_id"?: Database["public"]['Enums']["public_metric_id"] | null,"project_id"?: string,"published_at"?: string,"published_by"?: string,"revoked_at"?: string | null,"revoked_by"?: string | null,"rounding"?: Database["public"]['Enums']["published_metric_rounding"],"self_reported_label"?: string | null,"self_reported_unit"?: string | null,"self_reported_value"?: number | null,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "published_metrics_project_fkey"
      columns: ["workspace_id","project_id"]
isOneToOne: false
      referencedRelation: "projects"
      referencedColumns: ["workspace_id","id"]
    },{
      foreignKeyName: "published_metrics_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"sync_jobs": {
                  Row: {
                    "attempts": number,"connection_id": string | null,"created_at": string,"dedupe_key": string | null,"error_code": string | null,"error_reference": string | null,"finished_at": string | null,"id": string,"kind": Database["public"]['Enums']["sync_job_kind"],"locked_until": string | null,"max_attempts": number,"run_after": string,"started_at": string | null,"status": Database["public"]['Enums']["sync_job_status"],"webhook_delivery_id": string | null,"workspace_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "attempts"?: number,"connection_id"?: string | null,"created_at"?: string,"dedupe_key"?: string | null,"error_code"?: string | null,"error_reference"?: string | null,"finished_at"?: string | null,"id"?: string,"kind": Database["public"]['Enums']["sync_job_kind"],"locked_until"?: string | null,"max_attempts"?: number,"run_after"?: string,"started_at"?: string | null,"status"?: Database["public"]['Enums']["sync_job_status"],"webhook_delivery_id"?: string | null,"workspace_id"?: string | null
                  }
                  Update: {
                    "attempts"?: number,"connection_id"?: string | null,"created_at"?: string,"dedupe_key"?: string | null,"error_code"?: string | null,"error_reference"?: string | null,"finished_at"?: string | null,"id"?: string,"kind"?: Database["public"]['Enums']["sync_job_kind"],"locked_until"?: string | null,"max_attempts"?: number,"run_after"?: string,"started_at"?: string | null,"status"?: Database["public"]['Enums']["sync_job_status"],"webhook_delivery_id"?: string | null,"workspace_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "sync_jobs_connection_fkey"
      columns: ["workspace_id","connection_id"]
isOneToOne: false
      referencedRelation: "connections"
      referencedColumns: ["workspace_id","id"]
    },{
      foreignKeyName: "sync_jobs_webhook_delivery_id_fkey"
      columns: ["webhook_delivery_id"]
isOneToOne: false
      referencedRelation: "webhook_deliveries"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "sync_jobs_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"triggered_alerts": {
                  Row: {
                    "acknowledged_at": string | null,"acknowledged_by": string | null,"currency": string | null,"cycle_key": string,"dispatched_at": string | null,"id": string,"is_estimated": boolean,"message": string,"observed_amount_minor": number | null,"observed_value": number | null,"project_id": string | null,"provider": Database["public"]['Enums']["provider_id"] | null,"resets_at": string | null,"rule_id": string,"threshold_label": string,"title": string | null,"triggered_at": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "acknowledged_at"?: string | null,"acknowledged_by"?: string | null,"currency"?: string | null,"cycle_key": string,"dispatched_at"?: string | null,"id"?: string,"is_estimated": boolean,"message": string,"observed_amount_minor"?: number | null,"observed_value"?: number | null,"project_id"?: string | null,"provider"?: Database["public"]['Enums']["provider_id"] | null,"resets_at"?: string | null,"rule_id": string,"threshold_label": string,"title"?: string | null,"triggered_at"?: string,"workspace_id": string
                  }
                  Update: {
                    "acknowledged_at"?: string | null,"acknowledged_by"?: string | null,"currency"?: string | null,"cycle_key"?: string,"dispatched_at"?: string | null,"id"?: string,"is_estimated"?: boolean,"message"?: string,"observed_amount_minor"?: number | null,"observed_value"?: number | null,"project_id"?: string | null,"provider"?: Database["public"]['Enums']["provider_id"] | null,"resets_at"?: string | null,"rule_id"?: string,"threshold_label"?: string,"title"?: string | null,"triggered_at"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "triggered_alerts_project_fkey"
      columns: ["workspace_id","project_id"]
isOneToOne: false
      referencedRelation: "projects"
      referencedColumns: ["workspace_id","id"]
    },{
      foreignKeyName: "triggered_alerts_rule_fkey"
      columns: ["workspace_id","rule_id"]
isOneToOne: false
      referencedRelation: "alert_rules"
      referencedColumns: ["workspace_id","id"]
    },{
      foreignKeyName: "triggered_alerts_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"usage_snapshots": {
                  Row: {
                    "amount_minor": number | null,"connection_id": string,"created_at": string,"currency": string | null,"external_account_id": string,"id": string,"kind": Database["public"]['Enums']["metric_kind"],"label": string,"metric_key": string,"period_end": string | null,"period_start": string | null,"point_at": string | null,"pricing_source": string | null,"provenance_endpoint": string | null,"provenance_source": string,"resets_at": string | null,"retrieved_at": string,"snapshot_date": string,"unit": string | null,"updated_at": string,"value": number | null,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "amount_minor"?: number | null,"connection_id": string,"created_at"?: string,"currency"?: string | null,"external_account_id": string,"id"?: string,"kind": Database["public"]['Enums']["metric_kind"],"label": string,"metric_key": string,"period_end"?: string | null,"period_start"?: string | null,"point_at"?: string | null,"pricing_source"?: string | null,"provenance_endpoint"?: string | null,"provenance_source": string,"resets_at"?: string | null,"retrieved_at": string,"snapshot_date": string,"unit"?: string | null,"updated_at"?: string,"value"?: number | null,"workspace_id": string
                  }
                  Update: {
                    "amount_minor"?: number | null,"connection_id"?: string,"created_at"?: string,"currency"?: string | null,"external_account_id"?: string,"id"?: string,"kind"?: Database["public"]['Enums']["metric_kind"],"label"?: string,"metric_key"?: string,"period_end"?: string | null,"period_start"?: string | null,"point_at"?: string | null,"pricing_source"?: string | null,"provenance_endpoint"?: string | null,"provenance_source"?: string,"resets_at"?: string | null,"retrieved_at"?: string,"snapshot_date"?: string,"unit"?: string | null,"updated_at"?: string,"value"?: number | null,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "usage_snapshots_connection_fkey"
      columns: ["workspace_id","connection_id"]
isOneToOne: false
      referencedRelation: "connections"
      referencedColumns: ["workspace_id","id"]
    },{
      foreignKeyName: "usage_snapshots_external_account_fkey"
      columns: ["workspace_id","external_account_id"]
isOneToOne: false
      referencedRelation: "external_accounts"
      referencedColumns: ["workspace_id","id"]
    },{
      foreignKeyName: "usage_snapshots_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"webhook_deliveries": {
                  Row: {
                    "delivery_id": string,"endpoint_id": string | null,"id": string,"outcome": Json | null,"processed_at": string | null,"provider": Database["public"]['Enums']["provider_id"],"received_at": string,"status": Database["public"]['Enums']["webhook_delivery_status"]
                  }
                  ComputedFields: never
                  Insert: {
                    "delivery_id": string,"endpoint_id"?: string | null,"id"?: string,"outcome"?: Json | null,"processed_at"?: string | null,"provider": Database["public"]['Enums']["provider_id"],"received_at"?: string,"status"?: Database["public"]['Enums']["webhook_delivery_status"]
                  }
                  Update: {
                    "delivery_id"?: string,"endpoint_id"?: string | null,"id"?: string,"outcome"?: Json | null,"processed_at"?: string | null,"provider"?: Database["public"]['Enums']["provider_id"],"received_at"?: string,"status"?: Database["public"]['Enums']["webhook_delivery_status"]
                  }
                  Relationships: [
                    {
      foreignKeyName: "webhook_deliveries_endpoint_id_fkey"
      columns: ["endpoint_id"]
isOneToOne: false
      referencedRelation: "webhook_endpoints"
      referencedColumns: ["id"]
    }
                  ]
                },"webhook_endpoints": {
                  Row: {
                    "auth_tag": string,"awaiting_provider_secret": boolean,"ciphertext": string,"connection_id": string,"created_at": string,"id": string,"iv": string,"key_id": string,"per_source": boolean,"provider": Database["public"]['Enums']["provider_id"],"provider_webhook_id": string | null,"setup_mode": Database["public"]['Enums']["webhook_setup_mode"],"updated_at": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "auth_tag": string,"awaiting_provider_secret"?: boolean,"ciphertext": string,"connection_id": string,"created_at"?: string,"id"?: string,"iv": string,"key_id": string,"per_source"?: boolean,"provider": Database["public"]['Enums']["provider_id"],"provider_webhook_id"?: string | null,"setup_mode"?: Database["public"]['Enums']["webhook_setup_mode"],"updated_at"?: string,"workspace_id": string
                  }
                  Update: {
                    "auth_tag"?: string,"awaiting_provider_secret"?: boolean,"ciphertext"?: string,"connection_id"?: string,"created_at"?: string,"id"?: string,"iv"?: string,"key_id"?: string,"per_source"?: boolean,"provider"?: Database["public"]['Enums']["provider_id"],"provider_webhook_id"?: string | null,"setup_mode"?: Database["public"]['Enums']["webhook_setup_mode"],"updated_at"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "webhook_endpoints_connection_fkey"
      columns: ["workspace_id","connection_id"]
isOneToOne: false
      referencedRelation: "connections"
      referencedColumns: ["workspace_id","id"]
    },{
      foreignKeyName: "webhook_endpoints_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"webhook_sources": {
                  Row: {
                    "created_at": string,"endpoint_id": string,"last_delivery_at": string | null,"provider_webhook_id": string | null,"provider_webhook_outdated": boolean,"source_id": string,"source_name": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"endpoint_id": string,"last_delivery_at"?: string | null,"provider_webhook_id"?: string | null,"provider_webhook_outdated"?: boolean,"source_id": string,"source_name": string,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"endpoint_id"?: string,"last_delivery_at"?: string | null,"provider_webhook_id"?: string | null,"provider_webhook_outdated"?: boolean,"source_id"?: string,"source_name"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "webhook_sources_endpoint_id_fkey"
      columns: ["endpoint_id"]
isOneToOne: false
      referencedRelation: "webhook_endpoints"
      referencedColumns: ["id"]
    }
                  ]
                },"workspace_members": {
                  Row: {
                    "created_at": string,"role": Database["public"]['Enums']["workspace_role"],"user_id": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"role": Database["public"]['Enums']["workspace_role"],"user_id": string,"workspace_id": string
                  }
                  Update: {
                    "created_at"?: string,"role"?: Database["public"]['Enums']["workspace_role"],"user_id"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "workspace_members_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"workspaces": {
                  Row: {
                    "anomaly_detection_enabled": boolean,"created_at": string,"created_by": string | null,"handle": string | null,"id": string,"is_personal": boolean,"name": string,"slug": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "anomaly_detection_enabled"?: boolean,"created_at"?: string,"created_by"?: string | null,"handle"?: string | null,"id"?: string,"is_personal"?: boolean,"name": string,"slug"?: string,"updated_at"?: string
                  }
                  Update: {
                    "anomaly_detection_enabled"?: boolean,"created_at"?: string,"created_by"?: string | null,"handle"?: string | null,"id"?: string,"is_personal"?: boolean,"name"?: string,"slug"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    
                  ]
                }
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "achievement_event_dedupe_key":
{ Args: { "p_achievement_id": string,"p_project_id": string }; Returns: string
                           },
"acquire_credential_refresh_lock":
{ Args: { "p_connection_id": string,"p_lease_seconds": number,"p_workspace_id": string }; Returns: string
                           },
"activity_event_counts":
{ Args: { "p_account_ids"?: (string)[],"p_bucket": string,"p_providers"?: (Database["public"]['Enums']["provider_id"])[],"p_since": string,"p_type_ids": (string)[],"p_workspace_id": string }; Returns: {
              "bucket_start": string,"event_count": number,"provider": Database["public"]['Enums']["provider_id"],"type_id": string
            }[]
                           },
"activity_heatmap":
{ Args: { "p_account_ids"?: (string)[],"p_providers"?: (Database["public"]['Enums']["provider_id"])[],"p_severities"?: (Database["public"]['Enums']["event_severity"])[],"p_since": string,"p_time_zone": string,"p_type_ids"?: (string)[],"p_workspace_id": string }; Returns: {
              "events": number,"hour": number,"isodow": number
            }[]
                           },
"admin_instance_totals":
{ Args: Record<PropertyKey, never>; Returns: {
              "connections": number,"events": number,"memberships": number,"users": number,"users_new_30d": number,"users_new_7d": number,"users_signed_in_30d": number,"workspaces": number,"workspaces_new_30d": number,"workspaces_new_7d": number
            }[]
                           },
"admin_job_failures":
{ Args: Record<PropertyKey, never>; Returns: {
              "error_code": string,"failures": number,"kind": Database["public"]['Enums']["sync_job_kind"],"last_failed_at": string
            }[]
                           },
"admin_job_health":
{ Args: Record<PropertyKey, never>; Returns: {
              "due": number,"failed_24h": number,"kind": Database["public"]['Enums']["sync_job_kind"],"last_finished_at": string,"oldest_due_at": string,"queued": number,"retrying": number,"running": number,"stale": number,"succeeded_24h": number
            }[]
                           },
"admin_latest_migration":
{ Args: Record<PropertyKey, never>; Returns: string
                           },
"admin_provider_usage":
{ Args: Record<PropertyKey, never>; Returns: {
              "active": number,"failed": number,"needs_attention": number,"pending": number,"provider": Database["public"]['Enums']["provider_id"],"revoked": number,"workspaces": number
            }[]
                           },
"admin_workspace_stats":
{ Args: { "p_after_created_at"?: string,"p_after_id"?: string,"p_limit": number }; Returns: {
              "connections": number,"created_at": string,"events": number,"is_personal": boolean,"members": number,"name": string,"slug": string,"workspace_id": string
            }[]
                           },
"api_activity_events":
{ Args: { "p_after_id"?: string,"p_after_occurred_at"?: string,"p_from"?: string,"p_limit"?: number,"p_provider"?: Database["public"]['Enums']["provider_id"],"p_severity"?: Database["public"]['Enums']["event_severity"],"p_to"?: string,"p_token_hash": string,"p_type_id"?: string }; Returns: {
              "account_name": string,"body": string,"connection_id": string,"external_account_id": string,"granted_scopes": (string)[],"id": string,"occurred_at": string,"provider": Database["public"]['Enums']["provider_id"],"severity": Database["public"]['Enums']["event_severity"],"title": string,"type_id": string,"url": string
            }[]
                           },
"api_connections":
{ Args: { "p_after_created_at"?: string,"p_after_id"?: string,"p_limit"?: number,"p_token_hash": string }; Returns: {
              "authorized_account_label": string,"created_at": string,"display_name": string,"granted_scopes": (string)[],"id": string,"last_synced_at": string,"provider": Database["public"]['Enums']["provider_id"],"status": Database["public"]['Enums']["connection_status"]
            }[]
                           },
"api_key_workspace":
{ Args: { "p_scope": Database["public"]['Enums']["api_key_scope"],"p_token_hash": string }; Returns: string
                           },
"api_projects":
{ Args: { "p_after_created_at"?: string,"p_after_id"?: string,"p_limit"?: number,"p_token_hash": string }; Returns: {
              "created_at": string,"id": string,"name": string
            }[]
                           },
"api_triggered_alerts":
{ Args: { "p_acknowledged"?: boolean,"p_after_id"?: string,"p_after_triggered_at"?: string,"p_limit"?: number,"p_token_hash": string }; Returns: {
              "acknowledged_at": string,"currency": string,"cycle_key": string,"id": string,"is_estimated": boolean,"message": string,"observed_amount_minor": number,"observed_value": number,"rule_id": string,"threshold_label": string,"threshold_percent": number,"triggered_at": string
            }[]
                           },
"api_usage_snapshots":
{ Args: { "p_after_date"?: string,"p_after_id"?: string,"p_connection_id"?: string,"p_from"?: string,"p_kind"?: Database["public"]['Enums']["metric_kind"],"p_limit"?: number,"p_metric_key"?: string,"p_project_id"?: string,"p_provider"?: Database["public"]['Enums']["provider_id"],"p_to"?: string,"p_token_hash": string }; Returns: {
              "account_name": string,"amount_minor": number,"connection_id": string,"currency": string,"external_account_id": string,"granted_scopes": (string)[],"id": string,"kind": Database["public"]['Enums']["metric_kind"],"label": string,"metric_key": string,"period_end": string,"period_start": string,"point_at": string,"pricing_source": string,"project_id": string,"provenance_source": string,"provider": Database["public"]['Enums']["provider_id"],"resets_at": string,"retrieved_at": string,"snapshot_date": string,"unit": string,"value": number
            }[]
                           },
"api_workspaces":
{ Args: { "p_token_hash": string }; Returns: {
              "created_at": string,"id": string,"is_personal": boolean,"name": string,"slug": string
            }[]
                           },
"authenticate_api_key":
{ Args: { "p_token_hash": string }; Returns: {
              "key_id": string,"request_count": number,"scopes": (Database["public"]['Enums']["api_key_scope"])[],"status": string,"window_resets_at": string,"workspace_id": string
            }[]
                           },
"backfill_connection_granted_at":
{ Args: { "p_limit": number }; Returns: number
                           },
"bump_public_rate_limit":
{ Args: { "p_ip_hash": string }; Returns: number
                           },
"claim_sync_jobs":
{ Args: { "p_lease_seconds": number,"p_limit": number }; Returns: {
              "attempts": number,
"connection_id": string | null,
"created_at": string,
"dedupe_key": string | null,
"error_code": string | null,
"error_reference": string | null,
"finished_at": string | null,
"id": string,
"kind": Database["public"]['Enums']["sync_job_kind"],
"locked_until": string | null,
"max_attempts": number,
"run_after": string,
"started_at": string | null,
"status": Database["public"]['Enums']["sync_job_status"],
"webhook_delivery_id": string | null,
"workspace_id": string | null
            }[]
                          SetofOptions: {
        from: "*"
        to: "sync_jobs"
        isOneToOne: false
        isSetofReturn: true
      } },
"claim_webhook_jobs":
{ Args: { "p_lease_seconds": number,"p_limit": number }; Returns: {
              "attempts": number,
"connection_id": string | null,
"created_at": string,
"dedupe_key": string | null,
"error_code": string | null,
"error_reference": string | null,
"finished_at": string | null,
"id": string,
"kind": Database["public"]['Enums']["sync_job_kind"],
"locked_until": string | null,
"max_attempts": number,
"run_after": string,
"started_at": string | null,
"status": Database["public"]['Enums']["sync_job_status"],
"webhook_delivery_id": string | null,
"workspace_id": string | null
            }[]
                          SetofOptions: {
        from: "*"
        to: "sync_jobs"
        isOneToOne: false
        isSetofReturn: true
      } },
"create_notification_destination":
{ Args: { "p_all_rules": boolean,"p_auth_tag": string,"p_ciphertext": string,"p_created_by": string,"p_digest": Database["public"]['Enums']["digest_frequency"],"p_id": string,"p_iv": string,"p_key_id": string,"p_kind": Database["public"]['Enums']["destination_kind"],"p_name": string,"p_rule_ids": (string)[],"p_url_host": string,"p_workspace_id": string }; Returns: undefined
                           },
"create_workspace":
{ Args: { "p_is_personal": boolean,"p_name": string,"p_user_id": string }; Returns: {
              "anomaly_detection_enabled": boolean,
"created_at": string,
"created_by": string | null,
"handle": string | null,
"id": string,
"is_personal": boolean,
"name": string,
"slug": string,
"updated_at": string
            }
                          SetofOptions: {
        from: "*"
        to: "workspaces"
        isOneToOne: true
        isSetofReturn: false
      } },
"current_user_workspace_ids":
{ Args: { "p_min_role": Database["public"]['Enums']["workspace_role"] }; Returns: string[]
                           },
"delete_webhook_endpoint":
{ Args: { "p_connection_id": string,"p_workspace_id": string }; Returns: Json
                           },
"disable_project_page":
{ Args: { "p_actor_id": string,"p_project_id": string,"p_workspace_id": string }; Returns: string
                           },
"enqueue_alert_dispatches":
{ Args: Record<PropertyKey, never>; Returns: number
                           },
"enqueue_daily_summaries":
{ Args: { "p_date": string }; Returns: number
                           },
"enqueue_digests":
{ Args: { "p_date": string }; Returns: number
                           },
"enqueue_due_syncs":
{ Args: { "p_limit": number }; Returns: number
                           },
"enqueue_sync_job":
{ Args: { "p_connection_id": string,"p_workspace_id": string }; Returns: boolean
                           },
"generate_workspace_slug":
{ Args: Record<PropertyKey, never>; Returns: string
                           },
"has_workspace_role":
{ Args: { "p_min_role": Database["public"]['Enums']["workspace_role"],"p_workspace_id": string }; Returns: boolean
                           },
"headline_event_counts":
{ Args: { "p_account_ids": (string)[],"p_end": string,"p_start": string,"p_type_ids": (string)[],"p_workspace_id": string }; Returns: {
              "connection_id": string,"events": number,"type_id": string
            }[]
                           },
"headline_first_readings":
{ Args: { "p_account_ids": (string)[],"p_on_or_before": string,"p_workspace_id": string }; Returns: {
              "connection_id": string,"snapshot_date": string
            }[]
                           },
"hook_before_user_created":
{ Args: { "event": Json }; Returns: Json
                           },
"insert_activity_events":
{ Args: { "p_rows": Json }; Returns: number
                           },
"insert_first_connection":
{ Args: { "p_display_name": string,"p_poll_interval_seconds": number,"p_provider": Database["public"]['Enums']["provider_id"],"p_user_id": string,"p_workspace_id": string }; Returns: string
                           },
"latest_usage_resets":
{ Args: { "p_external_account_id": string,"p_workspace_id": string }; Returns: {
              "metric_key": string,"resets_at": string
            }[]
                           },
"list_webhook_targets":
{ Args: { "p_endpoint_id"?: string,"p_external_id"?: string,"p_installation_id"?: string,"p_provider": Database["public"]['Enums']["provider_id"] }; Returns: {
              "account_id": string,"connection_id": string,"granted_at": string,"mode": Database["public"]['Enums']["connection_mode"],"simulated": boolean,"workspace_id": string
            }[]
                           },
"notification_recipients":
{ Args: { "p_workspace_id": string }; Returns: {
              "email": string,"email_frequency": Database["public"]['Enums']["email_frequency"],"user_id": string
            }[]
                           },
"public_project_page":
{ Args: { "p_page_slug": string,"p_workspace_slug": string }; Returns: {
              "indexable": boolean,"project_id": string,"project_name": string,"workspace_handle": string,"workspace_id": string,"workspace_slug": string
            }[]
                           },
"public_project_page_sitemap":
{ Args: { "p_limit": number }; Returns: {
              "page_slug": string,"updated_at": string,"workspace_handle": string,"workspace_slug": string
            }[]
                           },
"public_published_achievements":
{ Args: { "p_project_id": string }; Returns: {
              "achievement_id": string,"earned_at": string,"earned_precision": Database["public"]['Enums']["achievement_date_precision"],"evidence": Database["public"]['Enums']["achievement_evidence"],"provider": Database["public"]['Enums']["provider_id"],"public_title": string,"published_at": string,"simulated": boolean,"threshold": number
            }[]
                           },
"public_published_metrics":
{ Args: { "p_project_id": string }; Returns: {
              "delay_days": number,"id": string,"metric_id": Database["public"]['Enums']["public_metric_id"],"project_id": string,"published_at": string,"rounding": Database["public"]['Enums']["published_metric_rounding"],"self_reported_label": string,"self_reported_unit": string,"self_reported_value": number,"workspace_id": string
            }[]
                           },
"publish_achievement":
{ Args: { "p_achievement_id": string,"p_actor_id": string,"p_project_id": string,"p_workspace_id": string }; Returns: string
                           },
"publish_metric":
{ Args: { "p_actor_id": string,"p_body": string,"p_delay_days": number,"p_metric_id": Database["public"]['Enums']["public_metric_id"],"p_project_id": string,"p_rounding": Database["public"]['Enums']["published_metric_rounding"],"p_title": string,"p_workspace_id": string }; Returns: string
                           },
"publish_self_reported_metric":
{ Args: { "p_actor_id": string,"p_body": string,"p_label": string,"p_project_id": string,"p_title": string,"p_unit": string,"p_value": number,"p_workspace_id": string }; Returns: string
                           },
"purge_activity_events":
{ Args: { "p_before": string,"p_limit": number }; Returns: number
                           },
"purge_notification_deliveries":
{ Args: { "p_before": string,"p_limit": number }; Returns: number
                           },
"purge_oauth_states":
{ Args: { "p_before": string,"p_limit": number }; Returns: number
                           },
"purge_public_rate_limit_counters":
{ Args: { "p_before": string,"p_limit": number }; Returns: number
                           },
"purge_published_metric_views":
{ Args: { "p_before": string,"p_limit": number }; Returns: number
                           },
"purge_sync_jobs":
{ Args: { "p_before": string,"p_limit": number }; Returns: number
                           },
"purge_usage_snapshots":
{ Args: { "p_before": string,"p_limit": number }; Returns: number
                           },
"purge_webhook_deliveries":
{ Args: { "p_before": string,"p_limit": number }; Returns: number
                           },
"rebuild_activity_event_daily_counts":
{ Args: { "p_workspace_id": string }; Returns: number
                           },
"record_project_achievements":
{ Args: { "p_achievements": Json,"p_project_id": string,"p_workspace_id": string }; Returns: string[]
                           },
"record_publication_event":
{ Args: { "p_body": string,"p_dedupe_key": string,"p_title": string,"p_type_id": string,"p_workspace_id": string }; Returns: undefined
                           },
"record_published_metric_view":
{ Args: { "p_metric_id": Database["public"]['Enums']["public_metric_id"],"p_project_id": string,"p_surface": Database["public"]['Enums']["share_surface"] }; Returns: undefined
                           },
"record_webhook_delivery":
{ Args: { "p_delivery_id": string,"p_endpoint_id"?: string,"p_outcome": Json,"p_provider": Database["public"]['Enums']["provider_id"] }; Returns: boolean
                           },
"record_webhook_source":
{ Args: { "p_endpoint_id": string,"p_received_at": string,"p_source_id": string,"p_source_name": string }; Returns: undefined
                           },
"remove_workspace_handle":
{ Args: { "p_actor_id": string,"p_workspace_id": string }; Returns: string
                           },
"request_manual_sync":
{ Args: { "p_connection_id": string,"p_cooldown_seconds": number,"p_workspace_id": string }; Returns: string
                           },
"require_published_metrics_admin":
{ Args: { "p_actor_id": string,"p_workspace_id": string }; Returns: undefined
                           },
"require_workspace_handle_admin":
{ Args: { "p_actor_id": string,"p_workspace_id": string }; Returns: undefined
                           },
"save_created_webhook_source":
{ Args: { "p_endpoint_id": string,"p_provider_webhook_id": string,"p_source_id": string,"p_source_name": string }; Returns: boolean
                           },
"save_project_page":
{ Args: { "p_actor_id": string,"p_indexable": boolean,"p_project_id": string,"p_slug": string,"p_workspace_id": string }; Returns: string
                           },
"set_workspace_handle":
{ Args: { "p_actor_id": string,"p_handle": string,"p_workspace_id": string }; Returns: string
                           },
"snapshot_currencies":
{ Args: { "p_workspace_id": string }; Returns: {
              "currency": string
            }[]
                           },
"snapshot_metric_options":
{ Args: { "p_kinds": (Database["public"]['Enums']["metric_kind"])[],"p_workspace_id": string }; Returns: {
              "connection_ids": (string)[],"label": string,"metric_key": string
            }[]
                           },
"snapshot_series_day_rows":
{ Args: { "p_kinds": (Database["public"]['Enums']["metric_kind"])[],"p_workspace_id": string }; Returns: {
              "amount_minor": number,"connection_id": string,"currency": string,"external_account_id": string,"id": string,"kind": Database["public"]['Enums']["metric_kind"],"label": string,"metric_key": string,"period_end": string,"period_start": string,"point_at": string,"pricing_source": string,"provenance_source": string,"provider": Database["public"]['Enums']["provider_id"],"resets_at": string,"retrieved_at": string,"snapshot_date": string,"unit": string,"value": number
            }[]
                           },
"timeline_activity_buckets":
{ Args: { "p_account_ids"?: (string)[],"p_from"?: string,"p_hidden_type_ids"?: (string)[],"p_providers"?: (Database["public"]['Enums']["provider_id"])[],"p_severities"?: (Database["public"]['Enums']["event_severity"])[],"p_title_pattern"?: string,"p_type_ids"?: (string)[],"p_until"?: string,"p_workspace_id": string }; Returns: {
              "bucket_end": string,"bucket_start": string,"critical_events": number,"events": number,"warning_events": number
            }[]
                           },
"timeline_connection_event_counts":
{ Args: { "p_account_ids"?: (string)[],"p_from"?: string,"p_hidden_type_ids"?: (string)[],"p_providers"?: (Database["public"]['Enums']["provider_id"])[],"p_severities"?: (Database["public"]['Enums']["event_severity"])[],"p_title_pattern"?: string,"p_type_ids"?: (string)[],"p_until"?: string,"p_workspace_id": string }; Returns: {
              "connection_id": string,"display_name": string,"events": number,"provider": Database["public"]['Enums']["provider_id"]
            }[]
                           },
"timeline_type_ids":
{ Args: { "p_workspace_id": string }; Returns: {
              "type_id": string
            }[]
                           },
"unpublish_achievement":
{ Args: { "p_achievement_id": string,"p_actor_id": string,"p_project_id": string,"p_workspace_id": string }; Returns: string
                           },
"unpublish_all_metrics":
{ Args: { "p_actor_id": string,"p_workspace_id": string }; Returns: {
              "achievements": number,"metrics": number
            }[]
                           },
"unpublish_metric":
{ Args: { "p_actor_id": string,"p_published_metric_id": string,"p_title": string,"p_workspace_id": string }; Returns: string
                           },
"usage_snapshot_monthly_latest":
{ Args: { "p_since": string,"p_workspace_id": string }; Returns: {
              "amount_minor": number | null,
"connection_id": string,
"created_at": string,
"currency": string | null,
"external_account_id": string,
"id": string,
"kind": Database["public"]['Enums']["metric_kind"],
"label": string,
"metric_key": string,
"period_end": string | null,
"period_start": string | null,
"point_at": string | null,
"pricing_source": string | null,
"provenance_endpoint": string | null,
"provenance_source": string,
"resets_at": string | null,
"retrieved_at": string,
"snapshot_date": string,
"unit": string | null,
"updated_at": string,
"value": number | null,
"workspace_id": string
            }[]
                          SetofOptions: {
        from: "*"
        to: "usage_snapshots"
        isOneToOne: false
        isSetofReturn: true
      } },
"usage_snapshot_series_heads":
{ Args: { "p_workspace_id": string }; Returns: {
              "amount_minor": number | null,
"connection_id": string,
"created_at": string,
"currency": string | null,
"external_account_id": string,
"id": string,
"kind": Database["public"]['Enums']["metric_kind"],
"label": string,
"metric_key": string,
"period_end": string | null,
"period_start": string | null,
"point_at": string | null,
"pricing_source": string | null,
"provenance_endpoint": string | null,
"provenance_source": string,
"resets_at": string | null,
"retrieved_at": string,
"snapshot_date": string,
"unit": string | null,
"updated_at": string,
"value": number | null,
"workspace_id": string
            }[]
                          SetofOptions: {
        from: "*"
        to: "usage_snapshots"
        isOneToOne: false
        isSetofReturn: true
      } },
"workspace_role_rank":
{ Args: { "p_role": Database["public"]['Enums']["workspace_role"] }; Returns: number
                           },
"year_review_event_counts":
{ Args: { "p_account_ids": (string)[],"p_excluded_type_ids": (string)[],"p_from": string,"p_until": string,"p_workspace_id": string }; Returns: {
              "bucket": string,"day": string,"events": number,"provider": Database["public"]['Enums']["provider_id"]
            }[]
                           },
"year_review_longest_run":
{ Args: { "p_account_ids": (string)[],"p_failure_type_id": string,"p_from": string,"p_success_type_id": string,"p_until": string,"p_workspace_id": string }; Returns: number
                           }
          }
          Enums: {
            "achievement_date_precision": "instant"|"day","achievement_evidence": "crossed"|"at_least","alert_rule_kind": "allowance_percent"|"spend_amount"|"budget_percent","alert_scope": "workspace"|"provider"|"project"|"connection","api_key_scope": "usage:read"|"events:read"|"alerts:read"|"connections:read","connection_mode": "live"|"test","connection_status": "pending"|"active"|"needs_attention"|"revoked"|"failed","destination_kind": "discord"|"slack"|"webhook","destination_status": "active"|"needs_attention","digest_frequency": "off"|"daily"|"weekly","email_frequency": "immediate"|"daily"|"weekly"|"off","event_severity": "info"|"success"|"warning"|"critical","metric_kind": "verified_spend"|"estimated_spend"|"included_allowance"|"remaining_allowance"|"usage"|"credit_balance"|"revenue"|"recurring_revenue","provider_id": "vercel"|"github"|"resend"|"stripe"|"supabase"|"fake"|"digitalocean"|"posthog"|"polar"|"sentry"|"railway"|"gitlab","public_metric_id": "github-stars"|"github-stars-gained-7d"|"github-stars-gained-30d"|"vercel-deployments-7d"|"vercel-deployments-30d"|"vercel-deployment-streak"|"supabase-signups-7d"|"supabase-signups-30d"|"resend-emails-month"|"resend-quota-percent-month"|"github-actions-minutes-month"|"stripe-customers-30d"|"stripe-payments-30d","published_metric_rounding": "exact"|"tens"|"hundreds"|"thousands","share_surface": "badge"|"card","sync_job_kind": "sync"|"daily_summary"|"retention"|"alert_dispatch"|"digest"|"webhook","sync_job_status": "queued"|"running"|"succeeded"|"failed","webhook_delivery_status": "received"|"processed","webhook_setup_mode": "manual"|"automatic","workspace_role": "owner"|"admin"|"viewer"
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
      Row: infer R
    }
    ? R
    : never
  : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Insert: infer I
    }
    ? I
    : never
  : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Update: infer U
    }
    ? U
    : never
  : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
  ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
  : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "public": {
          Enums: {
            "achievement_date_precision": ["instant", "day"],"achievement_evidence": ["crossed", "at_least"],"alert_rule_kind": ["allowance_percent", "spend_amount", "budget_percent"],"alert_scope": ["workspace", "provider", "project", "connection"],"api_key_scope": ["usage:read", "events:read", "alerts:read", "connections:read"],"connection_mode": ["live", "test"],"connection_status": ["pending", "active", "needs_attention", "revoked", "failed"],"destination_kind": ["discord", "slack", "webhook"],"destination_status": ["active", "needs_attention"],"digest_frequency": ["off", "daily", "weekly"],"email_frequency": ["immediate", "daily", "weekly", "off"],"event_severity": ["info", "success", "warning", "critical"],"metric_kind": ["verified_spend", "estimated_spend", "included_allowance", "remaining_allowance", "usage", "credit_balance", "revenue", "recurring_revenue"],"provider_id": ["vercel", "github", "resend", "stripe", "supabase", "fake", "digitalocean", "posthog", "polar", "sentry", "railway", "gitlab"],"public_metric_id": ["github-stars", "github-stars-gained-7d", "github-stars-gained-30d", "vercel-deployments-7d", "vercel-deployments-30d", "vercel-deployment-streak", "supabase-signups-7d", "supabase-signups-30d", "resend-emails-month", "resend-quota-percent-month", "github-actions-minutes-month", "stripe-customers-30d", "stripe-payments-30d"],"published_metric_rounding": ["exact", "tens", "hundreds", "thousands"],"share_surface": ["badge", "card"],"sync_job_kind": ["sync", "daily_summary", "retention", "alert_dispatch", "digest", "webhook"],"sync_job_status": ["queued", "running", "succeeded", "failed"],"webhook_delivery_status": ["received", "processed"],"webhook_setup_mode": ["manual", "automatic"],"workspace_role": ["owner", "admin", "viewer"]
          }
        }
} as const
