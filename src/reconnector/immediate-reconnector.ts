import type { UniplsReconnector } from './reconnector';

export class ImmediateReconnector implements UniplsReconnector {
  reconnect() {
    return true;
  }
}
