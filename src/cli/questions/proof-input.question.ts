import { Question, QuestionSet } from 'nest-commander';

export const validateNodeOperatorId = (val: string) => {
  if (!/^\d+$/.test(val)) {
    throw new Error('Node operator ID must be a number');
  }
  return val;
};

export const validateKeyIndex = (val: string) => {
  if (!/^\d+$/.test(val)) {
    throw new Error('Key index must be a number');
  }
  return val;
};

export const validateValidatorIndex = (val: string) => {
  if (!/^\d+$/.test(val)) {
    throw new Error('Validator index must be a number');
  }
  return val;
};

export const validateClBlock = (val: string) => {
  if (!/^0x[a-fA-F0-9]{64}$|^\d+$/.test(val)) {
    throw new Error('Block must be a 32-byte hex string or a number');
  }
  return val;
};

@QuestionSet({ name: 'proof-input' })
export class ProofInputQuestion {
  @Question({
    message: 'Node operator ID:',
    name: 'nodeOperatorId',
  })
  parseNodeOperatorId(val: string) {
    return validateNodeOperatorId(val);
  }

  @Question({
    message: 'Key index:',
    name: 'keyIndex',
  })
  parseKeyIndex(val: string) {
    return validateKeyIndex(val);
  }

  @Question({
    message: 'Validator index:',
    name: 'validatorIndex',
  })
  parseValidatorIndex(val: string) {
    return validateValidatorIndex(val);
  }

  @Question({
    message: 'Consensus Layer Block (root or slot number):',
    name: 'clBlock',
  })
  parseCLBlock(val: string) {
    return validateClBlock(val);
  }
}
