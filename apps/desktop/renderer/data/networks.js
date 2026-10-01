import { t } from '../i18n.js';
export const isEthernet = network => network?.type === 'ethernet';
export function networkDisplayName(network, connections = []) {
    if (network?.alias) return network.alias;
    if (isEthernet(network)) return connections.find(link => link.networkId === network.id)?.adapterAlias || network.adapterAlias || t('有线网络');
    return network?.ssid || network?.profileName || t('未识别网络');
}
