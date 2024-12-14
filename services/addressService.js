import * as soapService from './soapService.js';

const greaterThanCounter = process.env.COUNT;
const knownEmailServices = ['google.com', 'outlook.com', 'microsoft.com', 'hotmail.com', 'yahoo.com'];

async function bloquearConta(email) {
  try {
    const authToken = await soapService.makeAuthRequest();
    const zimbraId = await soapService.getAccountInfo(authToken, email);
    return await soapService.setAccountStatusBlocked(authToken, zimbraId);
  } catch (error) {
    const errorMessage = error?.message || 'Erro desconhecido';
    console.error('Erro ao bloquear a conta:', errorMessage);
    await soapService.sendTelegramMessage(`Erro ao bloquear a conta: ${errorMessage}`);
  }
}

async function adicionarObservacao(email) {
  try {
    const authToken = await soapService.makeAuthRequest();
    const zimbraId = await soapService.getAccountInfo(authToken, email);
    const currentDate = new Date().toLocaleDateString('pt-BR');
    const newObservation = `Email bloqueado em ${currentDate} (spam)`;
    return await soapService.addObservation(authToken, zimbraId, newObservation);
  } catch (error) {
    const errorMessage = error?.message || 'Erro desconhecido';
    console.error('Erro ao adicionar observação:', errorMessage);
    await soapService.sendTelegramMessage(`Erro ao adicionar a observação: ${errorMessage}`);
  }
}

export async function processAddresses({ qsFrom, qiList, authToken, addressIpData }) {
  const ipMap = mapIPs(qiList);
  const qsiList = qsFrom.qsi;

  for (const qsi of qsiList) {
    const fromAddress = qsi.$.t;
    const count = qsi.$.n;

    if (!fromAddress.includes('@')) {
      console.log(`Invalid email address: ${fromAddress}, skipping...`);
      continue;
    }

    const ip = ipMap.get(fromAddress) || 'IP not found';

    if (ip === 'IP not found') {
      console.log(`Address: ${fromAddress}, Count: ${count}, IP origem: ${ip}`);
      continue;
    }

    const geoData = await soapService.getGeolocation(ip);
    const country = geoData ? geoData.country : 'unknown';
    const isForeign = country !== 'BR';

    const hostname = geoData?.hostname || '';
    const isKnownService = knownEmailServices.some(service => hostname.includes(service));

    if (!addressIpData[fromAddress]) {
      addressIpData[fromAddress] = [];
    }

    const isIpNew = !addressIpData[fromAddress].includes(ip);

    console.log(`fromAddress: ${fromAddress}, isForeign: ${isForeign}, greaterThanCounter > ${greaterThanCounter}: ${count}, isKnownService: ${isKnownService}, isIpNew: ${isIpNew}`);

    if (isIpNew) {
      addressIpData[fromAddress].push(ip);
    }

    // Condição para bloqueio e alteração de senha
    const shouldBlock = isForeign
      && count > greaterThanCounter
      && !isKnownService
      && isIpNew
      && fromAddress.includes('ufcg.edu.br');

    if (shouldBlock) {
      await handleBlocking(authToken, fromAddress, ip, country, count);
    }
  }
}

function mapIPs(qiList) {
  const ipMap = new Map();
  qiList.forEach(qi => {
    const fromAddress = qi.$.from;
    const receivedIp = qi.$.received;
    if (fromAddress && receivedIp) {
      ipMap.set(fromAddress, receivedIp);
    }
  });
  return ipMap;
}

async function handleBlocking(authToken, fromAddress, ip, country, count) {
  try {
    const zimbraId = await soapService.getAccountInfo(authToken, fromAddress);
    const setPassword = await soapService.setPassword(authToken, zimbraId);

    let message = `*Address:* ${fromAddress},\n*Count:* ${count},\n*IP origem:* ${ip}${country !== 'BR' ? ' (estrangeiro: ' + country + ')' : ''}`;
    const bloquear = await bloquearConta(fromAddress);
    const observacao = await adicionarObservacao(fromAddress);

    if (setPassword !== undefined) {
      message += `,\n*Nova senha*: ${setPassword}`;
    }

    message += `,\n*Bloqueado*: ${bloquear}`;
    message += `,\n*Observação*: ${observacao}`;

    await soapService.sendTelegramMessage(message);
  } catch (error) {
    if (error.message.includes('no such account')) {
      console.log(`No such account for email: ${fromAddress}`);
      await soapService.sendTelegramMessage(`No such account for email: ${fromAddress}`);
    } else {
      throw error;
    }
  }
}
