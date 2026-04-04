import { type UniplsReconnector } from '../..';

export const immediateReconnector: UniplsReconnector = {
  reconnect: () => true,
};
