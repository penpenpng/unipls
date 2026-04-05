import type {
  UniplsReconnector,
  UniplsReconnectorActions,
} from './reconnector';

export class ImmediateReconnector implements UniplsReconnector {
  setup({ reconnect }: UniplsReconnectorActions) {
    reconnect();
  }
}
