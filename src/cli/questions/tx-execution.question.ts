import { Question, QuestionSet } from 'nest-commander';

@QuestionSet({ name: 'tx-execution' })
export class TxExecutionQuestion {
  @Question({
    type: 'confirm',
    askAnswered: true,
    message: 'Are you sure you want to send this transaction?',
    name: 'sendingConfirmed',
  })
  parseSendingConfirmed(val: boolean) {
    return val;
  }
}
