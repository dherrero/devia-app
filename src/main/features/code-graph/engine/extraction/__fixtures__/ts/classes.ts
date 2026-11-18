import { Base } from './base';

/** An animal that speaks. */
export class Animal extends Base implements Speaker {
  static count = 0;
  private name = 'x';

  speak(): string {
    return this.sound();
  }

  async sound(): Promise<string> {
    return util.greet(new Voice());
  }
}
