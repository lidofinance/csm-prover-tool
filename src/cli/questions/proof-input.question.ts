import { Question, QuestionSet } from 'nest-commander';

@QuestionSet({ name: 'proof-input' })
export class ProofInputQuestion {
  @Question({
    message: 'Node operator ID:',
    name: 'nodeOperatorId',
  })
  parseNodeOperatorId(val: string) {
    return val;
  }
  @Question({
    message: 'Key index:',
    name: 'keyIndex',
  })
  parseKeyIndex(val: string) {
    return val;
  }

  @Question({
    message: 'Validator index:',
    name: 'validatorIndex',
  })
  parseValidatorIndex(val: string) {
    return val;
  }

  @Question({
    message: 'Block (root or slot number):',
    name: 'block',
  })
  parseBlock(val: string) {
    return val;
  }
}
