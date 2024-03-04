export interface Status {
  appVersion: string;
  chainId: number;
  elBlockSnapshot: ELBlockSnapshot;
  clBlockSnapshot: CLBlockSnapshot;
}

export interface Modules {
  data: Module[];
  elBlockSnapshot: ELBlockSnapshot;
}

export interface ModuleKeys {
  data: {
    keys: Key[];
    module: Module;
  };
  meta: {
    elBlockSnapshot: ELBlockSnapshot;
  };
}

export interface ModuleKeysFind {
  data: {
    keys: Key[];
  };
  meta: {
    elBlockSnapshot: ELBlockSnapshot;
  };
}

export interface ELBlockSnapshot {
  blockNumber: number;
  blockHash: string;
  timestamp: number;
}

export interface CLBlockSnapshot {
  epoch: number;
  root: number;
  slot: number;
  blockNumber: number;
  timestamp: number;
  blockHash: string;
}

export interface Module {
  nonce: number;
  type: string;
  // unique id of the module
  id: number;
  // address of module
  stakingModuleAddress: string;
  // rewarf fee of the module
  moduleFee: number;
  // treasury fee
  treasuryFee: number;
  // target percent of total keys in protocol, in BP
  targetShare: number;
  // module status if module can not accept the deposits or can participate in further reward distribution
  status: number;
  // name of module
  name: string;
  // block.timestamp of the last deposit of the module
  lastDepositAt: number;
  // block.number of the last deposit of the module
  lastDepositBlock: number;
}

export interface Key {
  index: number;
  key: string;
  depositSignature: string;
  used: boolean;
  operatorIndex: number;
  moduleAddress: string;
}
