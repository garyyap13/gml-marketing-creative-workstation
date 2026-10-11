# The workstation serves one company, with no multi-tenancy

The workstation is an internal tool for one company (one brand, about seven people), not a product for other businesses. We deliberately rejected the TRD's multi-workspace design (workspace and brand memberships, tenant-qualified keys, cross-tenant tests, viewer and workspace-admin roles): everyone signed in can see everything, roles are Marketing or Creative plus an Approver flag, and Brand is a plain field on each Creative. We accept that serving other companies later would mean adding a tenant key to every table and policy.
