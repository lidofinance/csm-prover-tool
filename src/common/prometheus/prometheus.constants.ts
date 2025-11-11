export const APP_NAME = process.env.npm_package_name;
export const APP_DESCRIPTION = process.env.npm_package_description;

export const METRICS_URL = '/metrics';
export const METRICS_PREFIX = `${APP_NAME?.replace(/[- ]/g, '_')}_`;

export const METRIC_BUILD_INFO = `build_info`;

export const METRIC_OUTGOING_EL_REQUESTS_DURATION_SECONDS = `outgoing_el_requests_duration_seconds`;
export const METRIC_OUTGOING_EL_REQUESTS_COUNT = `outgoing_el_requests_count`;
export const METRIC_OUTGOING_CL_REQUESTS_DURATION_SECONDS = `outgoing_cl_requests_duration_seconds`;
export const METRIC_OUTGOING_CL_REQUESTS_COUNT = `outgoing_cl_requests_count`;
export const METRIC_OUTGOING_KEYSAPI_REQUESTS_DURATION_SECONDS = `outgoing_keysapi_requests_duration_seconds`;
export const METRIC_OUTGOING_KEYSAPI_REQUESTS_COUNT = `outgoing_keysapi_requests_count`;
export const METRIC_OUTGOING_IPFS_REQUESTS_DURATION_SECONDS = `outgoing_ipfs_requests_duration_seconds`;
export const METRIC_OUTGOING_IPFS_REQUESTS_COUNT = `outgoing_ipfs_requests_count`;
export const METRIC_TASK_DURATION_SECONDS = `task_duration_seconds`;
export const METRIC_TASK_RESULT_COUNT = `task_result_count`;

export const METRIC_HIGH_GAS_FEE_INTERRUPTIONS_COUNT = `high_gas_fee_interruptions_count`;
export const METRIC_TRANSACTION_COUNTER = `transaction_total`;

export const METRIC_DATA_ACTUALITY = `data_actuality`;
export const METRIC_LAST_PROCESSED_SLOT_NUMBER = `last_processed_slot_number`;
export const METRIC_ROOTS_STACK_SIZE = `roots_stack_size`;
export const METRIC_ROOTS_STACK_OLDEST_SLOT = `roots_stack_oldest_slot`;

export const METRIC_KEYS_INDEXER_STORAGE_STATE_SLOT = `keys_indexer_storage_state_slot`;
export const METRIC_KEYS_INDEXER_ALL_VALIDATORS_COUNT = `keys_indexer_all_validators_count`;
export const METRIC_KEYS_CSM_VALIDATORS_COUNT = `keys_csm_validators_count`;
