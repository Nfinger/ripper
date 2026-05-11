export type SupervisedProfileErrorCode =
  | 'profile_name_invalid'
  | 'profile_not_found'
  | 'profile_yaml_invalid'
  | 'profile_root_invalid'
  | 'profile_schema_version_missing'
  | 'profile_schema_version_unsupported'
  | 'profile_unknown_key'
  | 'profile_field_invalid'
  | 'agent_kind_unsupported'
  | 'repo_path_not_absolute';

export class SupervisedProfileError extends Error {
  readonly code: SupervisedProfileErrorCode;
  readonly path?: string;
  readonly field?: string;

  constructor(code: SupervisedProfileErrorCode, message: string, opts: { path?: string; field?: string } = {}) {
    super(message);
    this.name = 'SupervisedProfileError';
    this.code = code;
    if (opts.path !== undefined) this.path = opts.path;
    if (opts.field !== undefined) this.field = opts.field;
  }
}
