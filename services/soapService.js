import "dotenv/config";
import axios from "axios";
import xml2js from "xml2js";
import { Telegraf } from "telegraf";
import https from "https";

// Telegram
const TOKEN = process.env.TOKEN_ID;
const CHAT_ID = process.env.CHAT_ID;
const bot = new Telegraf(TOKEN);

/**
 * Envia mensagem formatada para o Telegram.
 */
export async function sendTelegramMessage(message) {
  try {
    const formattedMessage = `*Monitoramento Fila do Zimbra* ${process.env.HOSTNAME}\n\n${message}`;
    await bot.telegram.sendMessage(CHAT_ID, formattedMessage, {
      parse_mode: "Markdown",
    });
  } catch (error) {
    console.error("Erro ao enviar mensagem para o Telegram:", error);
  }
}

// Configuração global para requisições SOAP
const config = {
  method: "post",
  maxBodyLength: Infinity,
  url: process.env.WSDL_ZIMBRA,
  headers: {
    SOAPAction: '"#POST"',
    "Content-Type": "application/xml",
  },
  // Configurar para ignorar certificados autoassinados em ambiente de testes
  httpsAgent: new https.Agent({
    rejectUnauthorized: false,
  }),
};

/**
 * Obtem geolocalização de um IP usando ipinfo.io, com até 3 tentativas.
 */
export async function getGeolocation(ip, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await axios.get(
        `https://ipinfo.io/${ip}?token=86e8e6cb738beb`
      );
      return response.data;
    } catch (error) {
      console.error(
        `Erro ao obter geolocalização para o IP ${ip} (tentativa ${attempt} de ${retries}):`,
        error
      );

      // Verifica se é a última tentativa
      if (attempt === retries) {
        const errorMessage = formatError(error);
        await handleError(errorMessage);
        return null;
      }
    }
  }
}

/**
 * Gera uma senha aleatória entre 8 e 12 caracteres.
 */
function generateRandomPassword() {
  const length = Math.floor(Math.random() * (12 - 8 + 1)) + 8;
  const charset =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()_+~`|}{[]:;?><,./-=";
  let password = "";
  for (let i = 0, n = charset.length; i < length; ++i) {
    password += charset.charAt(Math.floor(Math.random() * n));
  }
  return password;
}

/**
 * Envia requisição SOAP genérica.
 */
export async function sendSoapRequest(data) {
  try {
    const response = await axios.request({ ...config, data });
    const parsedResponse = await xml2js.parseStringPromise(response.data);
    return parsedResponse;
  } catch (error) {
    console.log(error);
    const errorMessage = formatError(error);
    await handleError(errorMessage);
    // ao invés de `throw new Error("SOAP request failed")`, 
    // relançamos o *mesmo* error do Axios, mantendo 'error.response.data'
    throw error;
  }
}

/**
 * Faz autenticação e retorna o token de admin.
 */
export async function makeAuthRequest() {
  let authData = `<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns="urn:zimbra">
  <soap:Header/>
  <soap:Body>
    <AuthRequest xmlns="urn:zimbraAdmin">
      <account by="name">${process.env.USER_ADMIN_ZIMBRA}</account>
      <password>${process.env.PASSWORD}</password>
    </AuthRequest>
  </soap:Body>
  </soap:Envelope>`;

  try {
    const parsedResponse = await sendSoapRequest(authData);
    const authToken =
      parsedResponse["soap:Envelope"]["soap:Body"][0]["AuthResponse"][0][
      "authToken"
      ][0];
    return authToken;
  } catch (error) {
    console.log(error);
    const errorMessage = formatError(error);
    await handleError(errorMessage);
    throw new Error("Authentication failed");
  }
}

/**
 * Retorna o zimbraId de um e-mail. Se a conta não existir, retorna null.
 */
export async function getAccountInfo(authToken, email) {
  let data = `<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns="urn:zimbraAdmin">
  <soap:Header>
    <context xmlns="urn:zimbra">
      <authToken>${authToken}</authToken>
    </context>
  </soap:Header>
  <soap:Body>
    <GetAccountInfoRequest>
      <account by="name">${email}</account>
    </GetAccountInfoRequest>
  </soap:Body>
  </soap:Envelope>`;

  try {
    const parsedResponse = await sendSoapRequest(data);
    const zimbraId = parsedResponse["soap:Envelope"]["soap:Body"][0][
      "GetAccountInfoResponse"
    ][0]["a"].find((attr) => attr["$"].n === "zimbraId")["_"];
    return zimbraId;
  } catch (error) {
    // Se for "no such account", retornamos null ao invés de lançar erro
    if (error?.response?.data?.includes("no such account")) {
      console.log(`No such account for email: ${email}`);
      return null;
    }
    // Caso contrário, lance de novo
    throw error;
  }
}

/**
 * Define nova senha para uma conta. Se zimbraId vier null/undefined, apenas ignora.
 */
export async function setPassword(authToken, zimbraId) {
  // Se zimbraId for null, não chamamos SOAP (evitando erro 500).
  if (!zimbraId) {
    console.log("setPassword: zimbraId é nulo ou indefinido, ignorando requisição SOAP...");
    return null;
  }

  const newPassword = await generateRandomPassword();
  let data = `<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns="urn:zimbraAdmin">
  <soap:Header>
    <context xmlns="urn:zimbra">
      <authToken>${authToken}</authToken>
    </context>
  </soap:Header>
  <soap:Body>
     <SetPasswordRequest id="${zimbraId}" newPassword="${newPassword}" />
  </soap:Body>
  </soap:Envelope>`;

  try {
    const parsedResponse = await sendSoapRequest(data);
    // Se a resposta não tiver nada, retornamos a nova senha mesmo assim
    const message =
      parsedResponse["soap:Envelope"]?.["soap:Body"]?.[0]?.[
      "GetMailQueueResponse"
      ]?.[0]?.["message"]?.[0] || newPassword;
    return message;
  } catch (error) {
    const errorMessage = formatError(error);
    await handleError(errorMessage);
    console.log(error);
    return null;
  }
}

/**
 * Obtém a fila de e-mails no Zimbra.
 * https://files.zimbra.com/docs/soap_api/8.6.0/api-reference/index.html
 */
export async function getMailQueue(authToken, serverName) {
  let data = `<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns="urn:zimbraAdmin">
  <soap:Header>
    <context xmlns="urn:zimbra">
      <authToken>${authToken}</authToken>
    </context>
  </soap:Header>
  <soap:Body>
    <GetMailQueueRequest>
      <server name="${serverName}">
        <queue name="deferred" scan="1" wait="10">
          <query offset="0" limit="300"></query>
        </queue>
      </server>
    </GetMailQueueRequest>
  </soap:Body>
  </soap:Envelope>`;

  try {
    const parsedResponse = await sendSoapRequest(data);
    const mailQueue =
      parsedResponse["soap:Envelope"]["soap:Body"][0][
      "GetMailQueueResponse"
      ][0]["server"][0]["queue"][0];
    return mailQueue;
  } catch (error) {
    if (error?.response?.data?.includes("service.ALREADY_IN_PROGRESS")) {
      console.log("Operação já em progresso no servidor.");
      return null; // Retorna null para não interromper o fluxo
    }
    const errorMessage = formatError(error);
    await handleError(errorMessage);
    console.log(error);
    throw new Error("Falha ao obter a fila de e-mails.");
  }
}


/**
 * Formata o erro para exibição (tanto em log quanto no Telegram).
 */
export function formatError(error) {
  const cause = error.cause || error;

  // Extraindo partes relevantes do erro
  const shortError = {
    message: cause?.message || "Mensagem não disponível",
    errno: cause?.errno || "N/A",
    code: cause?.code || "N/A",
    syscall: cause?.syscall || "N/A",
    address: cause?.address || "N/A",
    port: cause?.port || "N/A",
  };

  // Formatando a mensagem de erro para o Telegram
  return `
    Error: ${shortError.message}
    Errno: ${shortError.errno}
    Code: ${shortError.code}
    Syscall: ${shortError.syscall}
    Address: ${shortError.address}
    Port: ${shortError.port}
  `;
}

// Armazenamento de mensagens enviadas recentemente (para evitar spam de erros repetidos)
const recentMessages = new Map();

/**
 * Trata o erro, enviando pelo Telegram se não for repetido (últimos 10 minutos).
 */
export async function handleError(error) {
  const errorMessage = formatError(error).trim();
  const causeMessage = error.cause ? error.cause.message : error.message;
  const currentTime = Date.now();
  const tenMinutesAgo = currentTime - 10 * 60 * 1000;

  // Remover mensagens que são mais antigas que 10 minutos
  for (const [message, timestamp] of recentMessages.entries()) {
    if (timestamp < tenMinutesAgo) {
      recentMessages.delete(message);
    }
  }

  // Verificar se a mensagem já foi enviada nos últimos 10 minutos ou se é genérica (N/A)
  if (recentMessages.has(causeMessage) || errorMessage.includes("N/A")) {
    console.log(
      "Mensagem repetida ou indefinida detectada, não enviando via Telegram"
    );
    return;
  }

  // Armazenar a mensagem atual com o timestamp
  recentMessages.set(causeMessage, currentTime);

  // Enviar a mensagem via Telegram
  await sendTelegramMessage(errorMessage);
}

/**
 * Bloqueia uma conta (zimbraAccountStatus = locked).
 */
export async function setAccountStatusBlocked(authToken, zimbraId) {
  // Se zimbraId for null, não chamamos SOAP (evitando erro 500).
  if (!zimbraId) {
    console.log("setAccountStatusBlocked: zimbraId é nulo/undefined, ignorando bloqueio...");
    return null;
  }

  let data = `<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns="urn:zimbraAdmin">
  <soap:Header>
    <context xmlns="urn:zimbra">
      <authToken>${authToken}</authToken>
    </context>
  </soap:Header>
  <soap:Body>
    <ModifyAccountRequest>
      <id>${zimbraId}</id>
      <a n="zimbraAccountStatus">locked</a>
    </ModifyAccountRequest>
  </soap:Body>
  </soap:Envelope>`;

  try {
    const parsedResponse = await sendSoapRequest(data);
    const result =
      parsedResponse["soap:Envelope"]["soap:Body"][0]["ModifyAccountResponse"];
    return result
      ? "Status do email alterado para bloqueado com sucesso!"
      : "Falha ao alterar o status do email.";
  } catch (error) {
    const errorMessage = formatError(error);
    await handleError(errorMessage);
    console.log(error);
    throw new Error("Falha ao bloquear o status da conta.");
  }
}

/**
 * Adiciona observação (zimbraNotes) na conta.
 */
export async function addObservation(authToken, zimbraId, newObservation) {
  try {
    // Se zimbraId for null, não chamamos SOAP.
    if (!zimbraId) {
      console.log("addObservation: zimbraId é nulo/undefined, ignorando alteração de notas...");
      return null;
    }

    // Etapa 1: Obter a observação atual
    let getAccountData = `<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns="urn:zimbraAdmin">
    <soap:Header>
      <context xmlns="urn:zimbra">
        <authToken>${authToken}</authToken>
      </context>
    </soap:Header>
    <soap:Body>
      <GetAccountRequest>
        <account by="id">${zimbraId}</account>
      </GetAccountRequest>
    </soap:Body>
    </soap:Envelope>`;

    const accountResponse = await sendSoapRequest(getAccountData);

    // Buscar o atributo "zimbraNotes" no array de atributos
    const attributes =
      accountResponse?.["soap:Envelope"]?.["soap:Body"]?.[0]?.[
      "GetAccountResponse"
      ]?.[0]?.["account"]?.[0]?.["a"] || [];
    const existingNotes =
      attributes.find((attr) => attr["$"]?.n === "zimbraNotes")?._ || "";

    // Etapa 2: Concatenar a nova observação com as existentes
    const updatedNotes = `${existingNotes}\n${newObservation}`.trim();

    // Etapa 3: Atualizar o campo zimbraNotes com o valor atualizado
    let modifyAccountData = `<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns="urn:zimbraAdmin">
    <soap:Header>
      <context xmlns="urn:zimbra">
        <authToken>${authToken}</authToken>
      </context>
    </soap:Header>
    <soap:Body>
      <ModifyAccountRequest>
        <id>${zimbraId}</id>
        <a n="zimbraNotes">${updatedNotes}</a>
      </ModifyAccountRequest>
    </soap:Body>
    </soap:Envelope>`;

    const modifyResponse = await sendSoapRequest(modifyAccountData);
    const result =
      modifyResponse["soap:Envelope"]["soap:Body"][0]["ModifyAccountResponse"];

    return result
      ? "Observação adicionada com sucesso!"
      : "Falha ao adicionar observação.";
  } catch (error) {
    const errorMessage = formatError(error);
    await handleError(errorMessage);
    console.log(error);
    throw new Error("Falha ao adicionar observação.");
  }
}

export async function getAccountAttributes(authToken, zimbraId) {
  const getAccountData = `<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns="urn:zimbraAdmin">
    <soap:Header>
      <context xmlns="urn:zimbra">
         <authToken>${authToken}</authToken>
       </context>
    </soap:Header>
     <soap:Body>
      <GetAccountRequest attrs="zimbraAccountStatus">
         <account by="id">${zimbraId}</account>
      </GetAccountRequest>
     </soap:Body>
     </soap:Envelope>`;

  try {
    console.log("Enviando solicitação SOAP para obter status da conta...");
    console.log(`zimbraId: ${zimbraId}`);

    const accountResponse = await sendSoapRequest(getAccountData);

    console.log("Resposta do servidor:", JSON.stringify(accountResponse, null, 2));

    // Verifica se houve erro SOAP
    if (accountResponse?.["soap:Envelope"]?.["soap:Body"]?.[0]?.["soap:Fault"]) {
      throw new Error(
        "Erro SOAP: " + JSON.stringify(accountResponse["soap:Envelope"]["soap:Body"][0]["soap:Fault"])
      );
    }

    // Buscar os atributos da conta
    const attributes =
      accountResponse?.["soap:Envelope"]?.["soap:Body"]?.[0]?.[
      "GetAccountResponse"
      ]?.[0]?.["account"]?.[0]?.["a"] || [];

    // Buscar o atributo "zimbraAccountStatus"
    const accountStatus =
      attributes.find((attr) => attr["$"]?.n === "zimbraAccountStatus")?._ || null;

    if (!accountStatus) {
      throw new Error("Atributo 'zimbraAccountStatus' não encontrado na resposta.");
    }

    return accountStatus; // Retorna apenas o status da conta

  } catch (error) {
    console.error(
      "Erro ao obter o status da conta:",
      error?.message || "Erro desconhecido"
    );
    return null;
  }
}
