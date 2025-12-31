import { atomWithLocalStorage } from '~/store/utils';

const agentInformationState = atomWithLocalStorage('agentInformationState', false);

export default {
  agentInformationState: agentInformationState,
};