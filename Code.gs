/* ============================================================
   doPost — API REST para o frontend GitHub Pages
   Todas as chamadas chegam como POST com JSON {action, params}
   ============================================================ */
function doPost(e) {
  var output;
  try {
    var body   = JSON.parse(e.postData.contents);
    var action = body.action || "";
    var p      = body.params || [];
    var result;

    switch (action) {
      // Auth
      case "validarAcesso":      result = validarAcesso(p[0],p[1],p[2],p[3]); break;
      case "sair":               result = sair(p[0]); break;
      case "trocarSenha":        result = trocarSenha(p[0],p[1],p[2]); break;
      case "adminResetarSenha":  result = adminResetarSenha(p[0],p[1],p[2]); break;
      // Painel
      case "getPainel":          result = getPainel(p[0],p[1]||null); break;
      // Arquitetos
      case "getArquitetosComSaldo":  result = getArquitetosComSaldo(p[0]); break;
      case "getArquitetosParaAdmin": result = { ok:true, lista: getArquitetosParaAdmin(p[0]) }; break;
      // Ranking / gráficos
      case "getRanking":         result = getRanking(p[0]); break;
      case "getGraficoMensal":   result = getGraficoMensal(p[0]); break;
      case "getPrevisaoCaixa":   result = getPrevisaoCaixa(p[0]); break;
      // Global admin
      case "getGlobalAdmin":     result = getGlobalAdmin(p[0],p[1]||{}); break;
      // Histórico
      case "getHistorico":       result = getHistorico(p[0]); break;
      // Relatório
      case "getRelatorio":       result = getRelatorio(p[0],p[1]||{}); break;
      // Catálogo
      case "getCatalogo":        result = getCatalogo(p[0]); break;
      case "getCatalogoAdmin":   result = getCatalogoAdmin(p[0]); break;
      case "adminSalvarItemCatalogo":  result = adminSalvarItemCatalogo(p[0],p[1]); break;
      case "adminExcluirItemCatalogo": result = adminExcluirItemCatalogo(p[0],p[1]); break;
      // Metas
      case "adminDefinirMeta":   result = adminDefinirMeta(p[0],p[1],p[2],p[3]); break;
      // Lançamentos
      case "adminLancarPontos":        result = adminLancarPontos(p[0],p[1]); break;
      case "adminEditarLancamento":    result = adminEditarLancamento(p[0],p[1],p[2]); break;
      case "adminExcluirLancamento":   result = adminExcluirLancamento(p[0],p[1]); break;
      case "adminLiberarPontos":       result = adminLiberarPontos(p[0],p[1]); break;
      case "adminAtualizarPrevisao":   result = adminAtualizarPrevisao(p[0],p[1],p[2]); break;
      // Resgates
      case "solicitarResgate":         result = solicitarResgate(p[0],p[1],p[2],p[3]||""); break;
      case "adminConcluirResgate":     result = adminConcluirResgate(p[0],p[1]); break;

      default:
        result = { ok: false, mensagem: "Ação desconhecida: " + action };
    }

    output = ContentService
      .createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    output = ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: true, mensagem: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  return output;
}

/* ============================================================
   doGet — mantém o app original do Apps Script funcionando
   ============================================================ */
function doGet() {
  return HtmlService.createHtmlOutputFromFile("Index")
    .setTitle("Sistema de Pontos - Arquitetos")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/***************
 * SISTEMA DE PONTOS - ARQUITETOS
 * Google Apps Script Web App
 ***************/

const CFG = {
  SHEET_USUARIOS:  "USUARIOS",
  SHEET_LANC:      "ARQUITETOS",
  SHEET_RESGATE:   "RESGATE",
  SHEET_HISTORICO: "HISTORICO",
  SHEET_CATALOGO:  "CATALOGO",
  SHEET_METAS:     "METAS",

  STATUS_PENDENTE:  "AGUARDANDO",
  STATUS_LIBERADO:  "LIBERADO",

  RESGATE_ABERTO:    "EM ABERTO",
  RESGATE_CONCLUIDO: "CONCLUÍDO",

  EXTRA_LANC_HEADERS:     ["ID", "Venda Interna", "Data Fechamento", "Observacao"],
  EXTRA_RESGATE_HEADERS:  ["ID", "Detalhes", "Catalogo ID"],
  EXTRA_USUARIOS_HEADERS: ["EMAIL", "SENHA_LEGIVEL"],

  NIVEIS: [
    { nome: "🥉 Bronze",   min: 0    },
    { nome: "🥈 Prata",    min: 500  },
    { nome: "🥇 Ouro",     min: 1500 },
    { nome: "💎 Platinum", min: 3000 }
  ],

  PONTOS_PARA_REAIS:   1.0,
  SESSION_TTL_SECONDS: 60 * 60 * 6
};

/* =========================================================
   HASH MD5
   ========================================================= */
function hashSenha_(senha) {
  const raw = Utilities.computeDigest(
    Utilities.DigestAlgorithm.MD5, senha, Utilities.Charset.UTF_8
  );
  return raw.map(b => ('0' + (b & 0xFF).toString(16)).slice(-2)).join('');
}

/* =========================================================
   NÍVEIS
   ========================================================= */
function calcularNivel_(totalPontos) {
  let nivel = CFG.NIVEIS[0];
  for (const n of CFG.NIVEIS) { if (totalPontos >= n.min) nivel = n; }
  const proximo = CFG.NIVEIS.find(n => n.min > totalPontos);
  return {
    nome:         nivel.nome,
    proximoNome:  proximo ? proximo.nome : null,
    faltam:       proximo ? proximo.min - totalPontos : 0,
    progressoPct: proximo
      ? Math.round(((totalPontos - nivel.min) / (proximo.min - nivel.min)) * 100)
      : 100
  };
}

/* =========================================================
   AUTENTICAÇÃO
   ========================================================= */
function validarAcesso(login, senha, ip, localizacao) {
  login       = (login       || "").trim();
  senha       = (senha       || "").trim();
  ip          = (ip          || "").trim();
  localizacao = (localizacao || "").trim();

  if (!login || !senha) return { sucesso: false, mensagem: "Informe login e senha." };

  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(CFG.SHEET_USUARIOS);
  if (!sh) return { sucesso: false, mensagem: "Aba USUARIOS não encontrada." };

  ensureUsuariosExtraColumns_();

  const values = sh.getDataRange().getValues();
  if (values.length < 2) return { sucesso: false, mensagem: "Nenhum usuário cadastrado." };

  const header     = mapHeaders_(values[0]);
  const idxNome    = col_(header, "NOME");
  const idxLogin   = col_(header, "LOGIN");
  const idxSenha   = col_(header, "SENHA");
  const idxFunc    = col_(header, "FUNÇÃO", "FUNCAO");
  const idxEmail   = col_(header, "EMAIL");
  const idxSenhaLg = col_(header, "SENHA_LEGIVEL");

  if ([idxNome, idxLogin, idxSenha, idxFunc].some(x => x == null))
    return { sucesso: false, mensagem: "Cabeçalhos inválidos na aba USUARIOS." };

  const senhaHash = hashSenha_(senha);

  const rowIndex = values.slice(1).findIndex(r =>
    String(r[idxLogin]).trim().toLowerCase() === login.toLowerCase() &&
    (String(r[idxSenha]).trim() === senha || String(r[idxSenha]).trim() === senhaHash)
  );

  if (rowIndex === -1) {
    registrarHistorico_(login, "LOGIN FALHOU", "Tentativa inválida", ip, localizacao);
    return { sucesso: false, mensagem: "Login ou Senha incorretos!" };
  }

  const row         = values[rowIndex + 1];
  const planilhaRow = rowIndex + 2;

  if (String(row[idxSenha]).trim() === senha)
    sh.getRange(planilhaRow, idxSenha + 1).setValue(senhaHash);

  if (idxSenhaLg != null)
    sh.getRange(planilhaRow, idxSenhaLg + 1).setValue(senha);

  const user = {
    nome:   String(row[idxNome]  || "").trim(),
    login:  String(row[idxLogin] || "").trim(),
    funcao: String(row[idxFunc]  || "").trim().toUpperCase(),
    email:  idxEmail != null ? String(row[idxEmail] || "").trim() : ""
  };

  registrarHistorico_(user.nome, "LOGIN", "Acesso autorizado", ip, localizacao);

  const token     = createSession_(user);
  const expiresAt = Date.now() + (CFG.SESSION_TTL_SECONDS * 1000);

  return { sucesso: true, token, nome: user.nome, funcao: user.funcao, expiresAt };
}

function trocarSenha(token, senhaAtual, novaSenha) {
  const user = getUserFromToken_(token);
  senhaAtual = (senhaAtual || "").trim();
  novaSenha  = (novaSenha  || "").trim();

  if (!senhaAtual || !novaSenha) throw new Error("Preencha todos os campos.");
  if (novaSenha.length < 4)     throw new Error("A nova senha deve ter ao menos 4 caracteres.");

  ensureUsuariosExtraColumns_();

  const ss     = SpreadsheetApp.getActive();
  const sh     = ss.getSheetByName(CFG.SHEET_USUARIOS);
  const values = sh.getDataRange().getValues();
  const header = mapHeaders_(values[0]);

  const idxLogin   = col_(header, "LOGIN");
  const idxSenha   = col_(header, "SENHA");
  const idxSenhaLg = col_(header, "SENHA_LEGIVEL");

  const rowIndex = values.slice(1).findIndex(r =>
    String(r[idxLogin]).trim().toLowerCase() === user.login.toLowerCase()
  );
  if (rowIndex === -1) throw new Error("Usuário não encontrado.");

  const senhaAtualHash  = hashSenha_(senhaAtual);
  const senhaArmazenada = String(values[rowIndex + 1][idxSenha]).trim();

  if (senhaArmazenada !== senhaAtual && senhaArmazenada !== senhaAtualHash)
    throw new Error("Senha atual incorreta.");

  const planilhaRow = rowIndex + 2;
  sh.getRange(planilhaRow, idxSenha + 1).setValue(hashSenha_(novaSenha));
  if (idxSenhaLg != null) sh.getRange(planilhaRow, idxSenhaLg + 1).setValue(novaSenha);

  registrarHistorico_(user.nome, "TROCA DE SENHA", "Senha alterada pelo usuário", "", "");
  return { ok: true, mensagem: "Senha alterada com sucesso!" };
}

function adminResetarSenha(token, loginAlvo, novaSenha) {
  const user = getUserFromToken_(token);
  if (user.funcao !== "ADMIN") throw new Error("Acesso negado.");

  novaSenha = (novaSenha || "").trim();
  if (!novaSenha || novaSenha.length < 4)
    throw new Error("Informe uma senha com ao menos 4 caracteres.");

  ensureUsuariosExtraColumns_();

  const ss     = SpreadsheetApp.getActive();
  const sh     = ss.getSheetByName(CFG.SHEET_USUARIOS);
  const values = sh.getDataRange().getValues();
  const header = mapHeaders_(values[0]);

  const idxLogin   = col_(header, "LOGIN");
  const idxSenha   = col_(header, "SENHA");
  const idxSenhaLg = col_(header, "SENHA_LEGIVEL");

  const rowIndex = values.slice(1).findIndex(r =>
    String(r[idxLogin]).trim().toLowerCase() === loginAlvo.toLowerCase()
  );
  if (rowIndex === -1) throw new Error("Usuário não encontrado.");

  const planilhaRow = rowIndex + 2;
  sh.getRange(planilhaRow, idxSenha + 1).setValue(hashSenha_(novaSenha));
  if (idxSenhaLg != null) sh.getRange(planilhaRow, idxSenhaLg + 1).setValue(novaSenha);

  registrarHistorico_(user.nome, "RESET DE SENHA", `Login alvo: ${loginAlvo}`, "", "");
  return { ok: true, mensagem: "Senha resetada com sucesso!" };
}

function sair(token) {
  if (!token) return { ok: true };
  CacheService.getScriptCache().remove(token);
  return { ok: true };
}

function createSession_(user) {
  const token = Utilities.getUuid();
  CacheService.getScriptCache().put(token, JSON.stringify(user), CFG.SESSION_TTL_SECONDS);
  return token;
}

function getUserFromToken_(token) {
  if (!token) throw new Error("Sessão inválida.");
  const raw = CacheService.getScriptCache().get(token);
  if (!raw)  throw new Error("Sessão expirada. Faça login novamente.");
  return JSON.parse(raw);
}

/* =========================================================
   HISTÓRICO
   ========================================================= */
function registrarHistorico_(nomeUsuario, acao, detalhes, ip, localizacao) {
  try {
    const ss = SpreadsheetApp.getActive();
    let sh   = ss.getSheetByName(CFG.SHEET_HISTORICO);
    if (!sh) {
      sh = ss.insertSheet(CFG.SHEET_HISTORICO);
      sh.getRange(1,1,1,6).setValues([["Data","Usuário","Ação","Detalhes","IP","Localização"]]);
    }
    sh.appendRow([new Date(), nomeUsuario||"", acao||"", detalhes||"", ip||"", localizacao||""]);
  } catch(e) {}
}

function getHistorico(token) {
  const user = getUserFromToken_(token);
  if (user.funcao !== "ADMIN") throw new Error("Acesso negado.");

  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(CFG.SHEET_HISTORICO);
  if (!sh) return { ok: true, rows: [] };

  const data = sh.getDataRange().getValues();
  if (data.length < 2) return { ok: true, rows: [] };

  const tz   = Session.getScriptTimeZone();
  const rows = [];

  for (let i = data.length - 1; i >= 1; i--) {
    const r = data[i];
    const d = (r[0] instanceof Date) ? r[0] : new Date(r[0]);
    rows.push({
      data:        !isNaN(d.getTime()) ? Utilities.formatDate(d, tz, "dd/MM/yyyy") : "",
      hora:        !isNaN(d.getTime()) ? Utilities.formatDate(d, tz, "HH:mm")      : "",
      usuario:     String(r[1] || ""),
      acao:        String(r[2] || ""),
      detalhes:    String(r[3] || ""),
      ip:          String(r[4] || ""),
      localizacao: String(r[5] || "")
    });
    if (rows.length >= 300) break;
  }
  return { ok: true, rows };
}

/* =========================================================
   ARQUITETOS COM SALDO
   ========================================================= */
function getArquitetosComSaldo(token) {
  const user = getUserFromToken_(token);
  if (user.funcao !== "ADMIN") throw new Error("Acesso negado.");

  const ss = SpreadsheetApp.getActive();

  const shU   = ss.getSheetByName(CFG.SHEET_USUARIOS);
  const lista = [];
  if (shU) {
    const v   = shU.getDataRange().getValues();
    const h   = mapHeaders_(v[0]);
    const iN  = col_(h, "NOME");
    const iF  = col_(h, "FUNÇÃO", "FUNCAO");
    for (let i = 1; i < v.length; i++) {
      const func = String(v[i][iF] || "").trim().toUpperCase();
      if (func === "ARQUITETO") lista.push(String(v[i][iN] || "").trim());
    }
  }
  lista.sort();

  const saldos = {};
  lista.forEach(n => { saldos[n] = { liberado: 0, resgatado: 0, reservado: 0 }; });

  const shLanc = ss.getSheetByName(CFG.SHEET_LANC);
  if (shLanc) {
    const d  = shLanc.getDataRange().getValues();
    const h  = mapHeaders_(d[0]);
    const iA = col_(h, "Arquiteto");
    const iP = col_(h, "Pontos Gerados", "Pontos");
    const iS = col_(h, "Status (Aguardando / Liberado)", "Status");
    for (let i = 1; i < d.length; i++) {
      const arq = String(d[i][iA] || "").trim();
      if (!saldos[arq]) continue;
      const pts    = toNumber_(d[i][iP]);
      const status = normalizeKey_(d[i][iS]);
      if (status === normalizeKey_(CFG.STATUS_LIBERADO)) saldos[arq].liberado += pts;
    }
  }

  const shResg = ss.getSheetByName(CFG.SHEET_RESGATE);
  if (shResg) {
    const d  = shResg.getDataRange().getValues();
    const h  = mapHeaders_(d[0]);
    const iA = col_(h, "Arquiteto");
    const iP = col_(h, "Pontos Solicitados", "Pontos");
    const iS = col_(h, "Status (Em Aberto / Concluido)", "Status (Em Aberto / Concluído)", "Status");
    for (let i = 1; i < d.length; i++) {
      const arq = String(d[i][iA] || "").trim();
      if (!saldos[arq]) continue;
      const pts    = toNumber_(d[i][iP]);
      const status = normalizeKey_(d[i][iS]);
      if (status === normalizeKey_(CFG.RESGATE_CONCLUIDO) || status === normalizeKey_("CONCLUIDO"))
        saldos[arq].resgatado += pts;
      if (status === normalizeKey_(CFG.RESGATE_ABERTO))
        saldos[arq].reservado += pts;
    }
  }

  const saldosFinais = {};
  for (const [nome, d] of Object.entries(saldos)) {
    saldosFinais[nome] = Math.max(0, d.liberado - d.resgatado - d.reservado);
  }

  return { ok: true, lista, saldos: saldosFinais };
}

/* =========================================================
   RELATÓRIO
   ========================================================= */
function getRelatorio(token, filtros) {
  const user = getUserFromToken_(token);
  if (user.funcao !== "ADMIN") throw new Error("Acesso negado.");

  ensureExtraColumns_();
  filtros = filtros || {};

  const arquitetoFiltro = (filtros.arquiteto || "").trim().toLowerCase();
  const dataIni         = filtros.dataIni ? new Date(filtros.dataIni) : null;
  const dataFim         = filtros.dataFim ? new Date(filtros.dataFim) : null;
  const tipoFiltro      = (filtros.tipo || "lancamentos").toLowerCase();

  const ss   = SpreadsheetApp.getActive();
  const tz   = Session.getScriptTimeZone();
  const rows = [];

  if (tipoFiltro === "lancamentos" || tipoFiltro === "todos") {
    const shLanc = ss.getSheetByName(CFG.SHEET_LANC);
    if (shLanc) {
      const d  = shLanc.getDataRange().getValues();
      const h  = mapHeaders_(d[0]);
      const iA = col_(h, "Arquiteto");
      const iC = col_(h, "Cliente da Obra", "Cliente");
      const iP = col_(h, "Pontos Gerados", "Pontos");
      const iD = col_(h, "Data do pagamento", "Data Pagamento", "Data");
      const iL = col_(h, "Data de Liberação", "Data de Liberacao", "Previsão", "Previsao");
      const iS = col_(h, "Status (Aguardando / Liberado)", "Status");
      const iV = col_(h, "Venda Interna");
      const iO = col_(h, "Observacao", "Observação");

      for (let i = 1; i < d.length; i++) {
        const r   = d[i];
        const arq = String(r[iA] || "").trim();
        if (!arq) continue;
        if (arquitetoFiltro && arq.toLowerCase() !== arquitetoFiltro) continue;
        const dtRaw = iD != null ? r[iD] : "";
        const dt    = dtRaw instanceof Date ? dtRaw : (dtRaw ? new Date(dtRaw) : null);
        if (dataIni && dt && dt < dataIni) continue;
        if (dataFim && dt && dt > dataFim) continue;

        rows.push({
          tipo:         "Lançamento",
          arquiteto:    arq,
          cliente:      String(r[iC] || "").trim(),
          pontos:       toNumber_(r[iP]),
          data:         dt ? Utilities.formatDate(dt, tz, "dd/MM/yyyy") : "",
          dataLiberacao:formatDate_(iL != null ? r[iL] : ""),
          status:       String(r[iS] || "").trim(),
          vendaInterna: iV != null ? String(r[iV] || "").trim() : "",
          observacao:   iO != null ? String(r[iO] || "").trim() : "",
          detalhes:     ""
        });
      }
    }
  }

  if (tipoFiltro === "resgates" || tipoFiltro === "todos") {
    const shResg = ss.getSheetByName(CFG.SHEET_RESGATE);
    if (shResg) {
      const d  = shResg.getDataRange().getValues();
      const h  = mapHeaders_(d[0]);
      const iA = col_(h, "Arquiteto");
      const iP = col_(h, "Pontos Solicitados", "Pontos");
      const iD = col_(h, "Data do Pedido", "Data");
      const iS = col_(h, "Status (Em Aberto / Concluido)", "Status (Em Aberto / Concluído)", "Status");
      const iT = col_(h, "Detalhes");

      for (let i = 1; i < d.length; i++) {
        const r   = d[i];
        const arq = String(r[iA] || "").trim();
        if (!arq) continue;
        if (arquitetoFiltro && arq.toLowerCase() !== arquitetoFiltro) continue;
        const dtRaw = iD != null ? r[iD] : "";
        const dt    = dtRaw instanceof Date ? dtRaw : (dtRaw ? new Date(dtRaw) : null);
        if (dataIni && dt && dt < dataIni) continue;
        if (dataFim && dt && dt > dataFim) continue;

        rows.push({
          tipo:         "Resgate",
          arquiteto:    arq,
          cliente:      "",
          pontos:       toNumber_(r[iP]),
          data:         dt ? Utilities.formatDate(dt, tz, "dd/MM/yyyy") : "",
          dataLiberacao:"",
          status:       String(r[iS] || "").trim(),
          vendaInterna: "",
          observacao:   "",
          detalhes:     iT != null ? String(r[iT] || "").trim() : ""
        });
      }
    }
  }

  registrarHistorico_(user.nome, "EXPORTAR RELATÓRIO",
    `Tipo: ${tipoFiltro} | Linhas: ${rows.length}`, "", "");

  return { ok: true, rows };
}

/* =========================================================
   CATÁLOGO
   ========================================================= */
function ensureCatalogo_() {
  const ss = SpreadsheetApp.getActive();
  let sh   = ss.getSheetByName(CFG.SHEET_CATALOGO);
  if (!sh) {
    sh = ss.insertSheet(CFG.SHEET_CATALOGO);
    sh.getRange(1,1,1,5).setValues([["ID","Nome","Pontos","Descricao","Ativo"]]);
  }
  return sh;
}

function getCatalogo(token) {
  getUserFromToken_(token);
  const sh   = ensureCatalogo_();
  const data = sh.getDataRange().getValues();
  if (data.length < 2) return { ok: true, itens: [] };

  const h     = mapHeaders_(data[0]);
  const iId   = col_(h, "ID");
  const iNome = col_(h, "Nome", "NOME");
  const iPts  = col_(h, "Pontos", "PONTOS");
  const iDesc = col_(h, "Descricao", "DESCRICAO", "Descrição");
  const iAtiv = col_(h, "Ativo", "ATIVO");

  return { ok: true, itens: data.slice(1)
    .filter(r => {
      const a = String(r[iAtiv] || "").trim().toUpperCase();
      return !(a === "NÃO" || a === "NAO" || a === "FALSE" || a === "0");
    })
    .map(r => ({
      id:    String(r[iId]   || "").trim(),
      nome:  String(r[iNome] || "").trim(),
      pontos:toNumber_(r[iPts]),
      desc:  iDesc != null ? String(r[iDesc] || "").trim() : ""
    }))
  };
}

function getCatalogoAdmin(token) {
  const user = getUserFromToken_(token);
  if (user.funcao !== "ADMIN") throw new Error("Acesso negado.");
  const sh   = ensureCatalogo_();
  const data = sh.getDataRange().getValues();
  if (data.length < 2) return { ok: true, itens: [] };

  const h     = mapHeaders_(data[0]);
  const iId   = col_(h, "ID");
  const iNome = col_(h, "Nome", "NOME");
  const iPts  = col_(h, "Pontos", "PONTOS");
  const iDesc = col_(h, "Descricao", "DESCRICAO", "Descrição");
  const iAtiv = col_(h, "Ativo", "ATIVO");

  return { ok: true, itens: data.slice(1).map(r => ({
    id:    String(r[iId]   || "").trim(),
    nome:  String(r[iNome] || "").trim(),
    pontos:toNumber_(r[iPts]),
    desc:  iDesc != null ? String(r[iDesc] || "").trim() : "",
    ativo: iAtiv != null ? String(r[iAtiv] || "").trim() : "Sim"
  }))};
}

function adminSalvarItemCatalogo(token, payload) {
  const user = getUserFromToken_(token);
  if (user.funcao !== "ADMIN") throw new Error("Acesso negado.");

  const nome   = String(payload.nome   || "").trim();
  const pontos = toNumber_(payload.pontos);
  const desc   = String(payload.desc   || "").trim();
  const ativo  = payload.ativo === false ? "Não" : "Sim";

  if (!nome)       throw new Error("Informe o nome do prêmio.");
  if (pontos <= 0) throw new Error("Informe os pontos.");

  const sh = ensureCatalogo_();

  if (payload.id) {
    const data = sh.getDataRange().getValues();
    const h    = mapHeaders_(data[0]);
    const row  = findRowById_(data, col_(h, "ID"), payload.id);
    if (!row) throw new Error("Item não encontrado.");
    const rn = row.rowNumber;
    const set = (cols, val) => { const i = col_(h,...cols); if (i!=null) sh.getRange(rn,i+1).setValue(val); };
    set(["Nome","NOME"], nome); set(["Pontos","PONTOS"], pontos);
    set(["Descricao","DESCRICAO","Descrição"], desc); set(["Ativo","ATIVO"], ativo);
    registrarHistorico_(user.nome, "EDITAR CATÁLOGO", `ID: ${payload.id}`, "", "");
    return { ok: true, mensagem: "Item atualizado!" };
  } else {
    sh.appendRow([Utilities.getUuid(), nome, pontos, desc, ativo]);
    registrarHistorico_(user.nome, "NOVO CATÁLOGO", `Nome: ${nome}`, "", "");
    return { ok: true, mensagem: "Item adicionado!" };
  }
}

function adminExcluirItemCatalogo(token, itemId) {
  const user = getUserFromToken_(token);
  if (user.funcao !== "ADMIN") throw new Error("Acesso negado.");
  const sh   = ensureCatalogo_();
  const data = sh.getDataRange().getValues();
  const h    = mapHeaders_(data[0]);
  const row  = findRowById_(data, col_(h, "ID"), itemId);
  if (!row) throw new Error("Item não encontrado.");
  sh.deleteRow(row.rowNumber);
  registrarHistorico_(user.nome, "EXCLUIR CATÁLOGO", `ID: ${itemId}`, "", "");
  return { ok: true };
}

/* =========================================================
   METAS
   ========================================================= */
function ensureMetas_() {
  const ss = SpreadsheetApp.getActive();
  let sh   = ss.getSheetByName(CFG.SHEET_METAS);
  if (!sh) {
    sh = ss.insertSheet(CFG.SHEET_METAS);
    sh.getRange(1,1,1,3).setValues([["Arquiteto","Meta","Periodo"]]);
  }
  return sh;
}

function getMeta_(nomeArquiteto) {
  const sh   = ensureMetas_();
  const data = sh.getDataRange().getValues();
  if (data.length < 2) return null;
  const h    = mapHeaders_(data[0]);
  const iA   = col_(h, "Arquiteto");
  const iM   = col_(h, "Meta");
  const iP   = col_(h, "Periodo");
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][iA]||"").trim().toLowerCase() === nomeArquiteto.toLowerCase())
      return { meta: toNumber_(data[i][iM]), periodo: String(data[i][iP]||"").trim() };
  }
  return null;
}

function adminDefinirMeta(token, arquiteto, meta, periodo) {
  const user = getUserFromToken_(token);
  if (user.funcao !== "ADMIN") throw new Error("Acesso negado.");
  meta = toNumber_(meta);
  if (!arquiteto) throw new Error("Informe o arquiteto.");
  if (meta <= 0)  throw new Error("Informe uma meta válida.");

  const sh   = ensureMetas_();
  const data = sh.getDataRange().getValues();
  const h    = mapHeaders_(data[0]);
  const iA   = col_(h, "Arquiteto");
  const iM   = col_(h, "Meta");
  const iP   = col_(h, "Periodo");

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][iA]||"").trim().toLowerCase() === arquiteto.toLowerCase()) {
      sh.getRange(i+1, iM+1).setValue(meta);
      if (iP != null) sh.getRange(i+1, iP+1).setValue(periodo||"");
      registrarHistorico_(user.nome, "DEFINIR META", `Arquiteto: ${arquiteto} | Meta: ${meta}`, "", "");
      return { ok: true, mensagem: "Meta atualizada!" };
    }
  }

  sh.appendRow([arquiteto, meta, periodo||""]);
  registrarHistorico_(user.nome, "DEFINIR META", `Arquiteto: ${arquiteto} | Meta: ${meta}`, "", "");
  return { ok: true, mensagem: "Meta definida!" };
}

/* =========================================================
   PAINEL
   ========================================================= */
function getPainel(token, arquitetoNomeOptional) {
  const user = getUserFromToken_(token);

  let alvoNome = user.nome;
  if (user.funcao === "ADMIN" && arquitetoNomeOptional) alvoNome = String(arquitetoNomeOptional).trim();
  if (user.funcao !== "ADMIN") alvoNome = user.nome;

  ensureExtraColumns_();

  const ss     = SpreadsheetApp.getActive();
  const shLanc = ss.getSheetByName(CFG.SHEET_LANC);
  const shResg = ss.getSheetByName(CFG.SHEET_RESGATE);
  if (!shLanc) throw new Error("Aba ARQUITETOS não encontrada.");
  if (!shResg) throw new Error("Aba RESGATE não encontrada.");

  const lancData = shLanc.getDataRange().getValues();
  const lh       = mapHeaders_(lancData[0]);

  const iA  = col_(lh, "Arquiteto");
  const iC  = col_(lh, "Cliente da Obra", "Cliente");
  const iP  = col_(lh, "Pontos Gerados", "Pontos");
  const iDP = col_(lh, "Data do pagamento", "Data Pagamento", "Data");
  const iDL = col_(lh, "Data de Liberação", "Data de Liberacao", "Previsão", "Previsao");
  const iS  = col_(lh, "Status (Aguardando / Liberado)", "Status");
  const iId = col_(lh, "ID");
  const iVI = col_(lh, "Venda Interna");
  const iDF = col_(lh, "Data Fechamento", "Data de Fechamento");
  const iOb = col_(lh, "Observacao", "Observação");

  const resgData = shResg.getDataRange().getValues();
  const rh       = mapHeaders_(resgData[0]);

  const rA  = col_(rh, "Arquiteto");
  const rP  = col_(rh, "Pontos Solicitados", "Pontos");
  const rD  = col_(rh, "Data do Pedido", "Data");
  const rS  = col_(rh, "Status (Em Aberto / Concluido)", "Status (Em Aberto / Concluído)", "Status");
  const rId = col_(rh, "ID");
  const rDt = col_(rh, "Detalhes");
  const rCI = col_(rh, "Catalogo ID");

  const rowsLanc = [];
  for (let i = 1; i < lancData.length; i++) {
    const r = lancData[i];
    if (String(r[iA]||"").trim().toLowerCase() !== alvoNome.toLowerCase()) continue;
    const id = getOrCreateId_(shLanc, i+1, iId);
    rowsLanc.push({
      id,
      cliente:        String(r[iC]  ||"").trim(),
      pontos:         toNumber_(r[iP]),
      dataPagamento:  formatDate_(iDP != null ? r[iDP] : ""),
      dataFechamento: formatDate_(iDF != null ? r[iDF] : ""),
      dataLiberacao:  formatDate_(iDL != null ? r[iDL] : ""),
      status:         normalizeKey_(r[iS]),
      vendaInterna:   iVI != null ? String(r[iVI]||"").trim() : "",
      observacao:     iOb != null ? String(r[iOb]||"").trim() : ""
    });
  }

  const rowsResg = [];
  for (let i = 1; i < resgData.length; i++) {
    const r = resgData[i];
    if (String(r[rA]||"").trim().toLowerCase() !== alvoNome.toLowerCase()) continue;
    const id = getOrCreateId_(shResg, i+1, rId);
    rowsResg.push({
      id,
      pontos:     toNumber_(r[rP]),
      dataPedido: formatDate_(rD  != null ? r[rD]  : ""),
      status:     normalizeKey_(r[rS]),
      detalhes:   rDt != null ? String(r[rDt]||"").trim() : "",
      catalogoId: rCI != null ? String(r[rCI]||"").trim() : ""
    });
  }

  const totalHistorico = rowsLanc.reduce((a,b)=>a+b.pontos, 0);
  const totalLiberado  = rowsLanc.filter(x=>x.status===normalizeKey_(CFG.STATUS_LIBERADO)).reduce((a,b)=>a+b.pontos,0);
  const totalPendente  = rowsLanc.filter(x=>x.status===normalizeKey_(CFG.STATUS_PENDENTE)).reduce((a,b)=>a+b.pontos,0);
  const totalResgatado = rowsResg.filter(x=>x.status===normalizeKey_(CFG.RESGATE_CONCLUIDO)||x.status===normalizeKey_("CONCLUIDO")).reduce((a,b)=>a+b.pontos,0);
  const totalResgAberto= rowsResg.filter(x=>x.status===normalizeKey_(CFG.RESGATE_ABERTO)).reduce((a,b)=>a+b.pontos,0);
  const saldoDisponivel= Math.max(0, totalLiberado - totalResgatado - totalResgAberto);

  const nivel = calcularNivel_(totalHistorico);
  const meta  = getMeta_(alvoNome);
  const tz    = Session.getScriptTimeZone();
  const mesAtual = Utilities.formatDate(new Date(), tz, "MM/yyyy");

  const pontosMes = rowsLanc
    .filter(x => (x.dataPagamento || x.dataFechamento || "").slice(3) === mesAtual)
    .reduce((a,b)=>a+b.pontos, 0);

  return {
    ok: true,
    usuario:   { nome: user.nome, funcao: user.funcao },
    alvoNome,
    nivel, pontosMes, meta,
    saldoEmReais: (saldoDisponivel * CFG.PONTOS_PARA_REAIS).toFixed(2),
    resumo: { saldoDisponivel, pendente: totalPendente, resgatado: totalResgatado, reservado: totalResgAberto, totalHistorico },
    tabelas: {
      pendentes: rowsLanc.filter(x=>x.status===normalizeKey_(CFG.STATUS_PENDENTE))
        .sort((a,b)=>(a.dataLiberacao||"").localeCompare(b.dataLiberacao||""))
        .map(x=>({ id:x.id, cliente:x.cliente, data:x.dataPagamento||x.dataFechamento, pontos:x.pontos, previsao:x.dataLiberacao, vendaInterna:x.vendaInterna, observacao:x.observacao })),
      liberados: rowsLanc.filter(x=>x.status===normalizeKey_(CFG.STATUS_LIBERADO))
        .sort((a,b)=>(b.dataLiberacao||"").localeCompare(a.dataLiberacao||""))
        .map(x=>({ id:x.id, cliente:x.cliente, data:x.dataPagamento||x.dataFechamento, pontos:x.pontos, liberacao:x.dataLiberacao, vendaInterna:x.vendaInterna, observacao:x.observacao })),
      resgatesAbertos:    rowsResg.filter(x=>x.status===normalizeKey_(CFG.RESGATE_ABERTO)).sort((a,b)=>(b.dataPedido||"").localeCompare(a.dataPedido||"")),
      resgatesConcluidos: rowsResg.filter(x=>x.status===normalizeKey_(CFG.RESGATE_CONCLUIDO)||x.status===normalizeKey_("CONCLUIDO")).sort((a,b)=>(b.dataPedido||"").localeCompare(a.dataPedido||""))
    }
  };
}

/* =========================================================
   ADMIN — ARQUITETOS (lista simples)
   ========================================================= */
function getArquitetosParaAdmin(token) {
  const user = getUserFromToken_(token);
  if (user.funcao !== "ADMIN") throw new Error("Acesso negado.");

  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(CFG.SHEET_USUARIOS);
  if (!sh) return [];

  const v   = sh.getDataRange().getValues();
  const h   = mapHeaders_(v[0]);
  const iN  = col_(h, "NOME");
  const iF  = col_(h, "FUNÇÃO", "FUNCAO");

  return v.slice(1)
    .filter(r => String(r[iF]||"").trim().toUpperCase() === "ARQUITETO")
    .map(r => String(r[iN]||"").trim())
    .sort();
}

/* =========================================================
   RANKING
   ========================================================= */
function getRanking(token) {
  getUserFromToken_(token);
  ensureExtraColumns_();

  const ss     = SpreadsheetApp.getActive();
  const shLanc = ss.getSheetByName(CFG.SHEET_LANC);
  const shResg = ss.getSheetByName(CFG.SHEET_RESGATE);
  if (!shLanc || !shResg) return { ok: true, ranking: [] };

  const ld = shLanc.getDataRange().getValues();
  const lh = mapHeaders_(ld[0]);
  const iA = col_(lh, "Arquiteto");
  const iP = col_(lh, "Pontos Gerados", "Pontos");
  const iS = col_(lh, "Status (Aguardando / Liberado)", "Status");
  const iD = col_(lh, "Data do pagamento", "Data Pagamento", "Data");
  const iF = col_(lh, "Data Fechamento", "Data de Fechamento");

  const rd  = shResg.getDataRange().getValues();
  const rh  = mapHeaders_(rd[0]);
  const rA  = col_(rh, "Arquiteto");
  const rP  = col_(rh, "Pontos Solicitados", "Pontos");
  const rS  = col_(rh, "Status (Em Aberto / Concluido)", "Status (Em Aberto / Concluído)", "Status");

  const tz  = Session.getScriptTimeZone();
  const mes = Utilities.formatDate(new Date(), tz, "MM/yyyy");
  const map = {};

  for (let i = 1; i < ld.length; i++) {
    const arq = String(ld[i][iA]||"").trim(); if (!arq) continue;
    if (!map[arq]) map[arq] = { total:0, mes:0, liberado:0, resgatado:0, reservado:0 };
    const pts = toNumber_(ld[i][iP]);
    map[arq].total += pts;
    const dt = formatDate_(iD != null ? ld[i][iD] : (iF != null ? ld[i][iF] : ""));
    if (dt.slice(3) === mes) map[arq].mes += pts;
    if (normalizeKey_(ld[i][iS]) === normalizeKey_(CFG.STATUS_LIBERADO)) map[arq].liberado += pts;
  }

  for (let i = 1; i < rd.length; i++) {
    const arq = String(rd[i][rA]||"").trim(); if (!arq || !map[arq]) continue;
    const pts = toNumber_(rd[i][rP]);
    const s   = normalizeKey_(rd[i][rS]);
    if (s === normalizeKey_(CFG.RESGATE_CONCLUIDO) || s === normalizeKey_("CONCLUIDO")) map[arq].resgatado += pts;
    if (s === normalizeKey_(CFG.RESGATE_ABERTO))   map[arq].reservado += pts;
  }

  const ranking = Object.entries(map).map(([nome, d]) => ({
    nome, total: d.total, mes: d.mes,
    saldo: Math.max(0, d.liberado - d.resgatado - d.reservado),
    nivel: calcularNivel_(d.total).nome
  })).sort((a,b) => b.mes - a.mes);

  return { ok: true, ranking, mesAtual: mes };
}

/* =========================================================
   GRÁFICO MENSAL
   ========================================================= */
function getGraficoMensal(token) {
  const user = getUserFromToken_(token);
  if (user.funcao !== "ADMIN") throw new Error("Acesso negado.");

  const shLanc = SpreadsheetApp.getActive().getSheetByName(CFG.SHEET_LANC);
  if (!shLanc) return { ok: true, meses: [] };

  const d   = shLanc.getDataRange().getValues();
  const h   = mapHeaders_(d[0]);
  const iP  = col_(h, "Pontos Gerados", "Pontos");
  const iD  = col_(h, "Data do pagamento", "Data Pagamento", "Data");
  const iF  = col_(h, "Data Fechamento", "Data de Fechamento");
  const map = {};

  for (let i = 1; i < d.length; i++) {
    const pts  = toNumber_(d[i][iP]);
    const data = formatDate_(iD != null ? d[i][iD] : (iF != null ? d[i][iF] : ""));
    if (!data) continue;
    const ch = data.slice(3);
    map[ch] = (map[ch]||0) + pts;
  }

  return { ok: true, meses: Object.entries(map)
    .map(([mes,pontos])=>({mes,pontos}))
    .sort((a,b)=>{
      const [ma,ya]=a.mes.split("/").map(Number);
      const [mb,yb]=b.mes.split("/").map(Number);
      return (ya*12+ma)-(yb*12+mb);
    }).slice(-12)
  };
}

/* =========================================================
   PREVISÃO DE CAIXA
   ========================================================= */
function getPrevisaoCaixa(token) {
  const user = getUserFromToken_(token);
  if (user.funcao !== "ADMIN") throw new Error("Acesso negado.");

  ensureExtraColumns_();
  const shLanc = SpreadsheetApp.getActive().getSheetByName(CFG.SHEET_LANC);
  if (!shLanc) return { ok: true, previsoes: [] };

  const d   = shLanc.getDataRange().getValues();
  const h   = mapHeaders_(d[0]);
  const iP  = col_(h, "Pontos Gerados", "Pontos");
  const iL  = col_(h, "Data de Liberação", "Data de Liberacao", "Previsão", "Previsao");
  const iS  = col_(h, "Status (Aguardando / Liberado)", "Status");
  const iA  = col_(h, "Arquiteto");
  const map = {};

  for (let i = 1; i < d.length; i++) {
    if (normalizeKey_(d[i][iS]) !== normalizeKey_(CFG.STATUS_PENDENTE)) continue;
    const pts  = toNumber_(d[i][iP]);
    const data = formatDate_(iL != null ? d[i][iL] : "");
    const arq  = String(d[i][iA]||"").trim();
    if (!data) continue;
    const ch = data.slice(3);
    if (!map[ch]) map[ch] = { pontos:0, arquitetos:[] };
    map[ch].pontos += pts;
    if (arq && !map[ch].arquitetos.includes(arq)) map[ch].arquitetos.push(arq);
  }

  return { ok: true, previsoes: Object.entries(map)
    .map(([mes,d])=>({mes,pontos:d.pontos,arquitetos:d.arquitetos}))
    .sort((a,b)=>{
      const [ma,ya]=a.mes.split("/").map(Number);
      const [mb,yb]=b.mes.split("/").map(Number);
      return (ya*12+ma)-(yb*12+mb);
    })
  };
}

/* =========================================================
   GLOBAL ADMIN
   ========================================================= */
function getGlobalAdmin(token, filtros) {
  const user = getUserFromToken_(token);
  if (user.funcao !== "ADMIN") throw new Error("Acesso negado.");

  ensureExtraColumns_();
  filtros = filtros || {};
  const dataIni = filtros.dataIni ? new Date(filtros.dataIni) : null;
  const dataFim = filtros.dataFim ? new Date(filtros.dataFim) : null;

  const ss     = SpreadsheetApp.getActive();
  const shLanc = ss.getSheetByName(CFG.SHEET_LANC);
  const shResg = ss.getSheetByName(CFG.SHEET_RESGATE);
  if (!shLanc) throw new Error("Aba ARQUITETOS não encontrada.");
  if (!shResg) throw new Error("Aba RESGATE não encontrada.");

  const ld  = shLanc.getDataRange().getValues();
  const lh  = mapHeaders_(ld[0]);
  const iA  = col_(lh, "Arquiteto");
  const iC  = col_(lh, "Cliente da Obra", "Cliente");
  const iP  = col_(lh, "Pontos Gerados", "Pontos");
  const iDP = col_(lh, "Data do pagamento", "Data Pagamento", "Data");
  const iDL = col_(lh, "Data de Liberação", "Data de Liberacao", "Previsão", "Previsao");
  const iS  = col_(lh, "Status (Aguardando / Liberado)", "Status");
  const iId = col_(lh, "ID");
  const iDF = col_(lh, "Data Fechamento", "Data de Fechamento");
  const iVI = col_(lh, "Venda Interna");
  const iOb = col_(lh, "Observacao", "Observação");

  const rd  = shResg.getDataRange().getValues();
  const rh  = mapHeaders_(rd[0]);
  const rA  = col_(rh, "Arquiteto");
  const rP  = col_(rh, "Pontos Solicitados", "Pontos");
  const rD  = col_(rh, "Data do Pedido", "Data");
  const rS  = col_(rh, "Status (Em Aberto / Concluido)", "Status (Em Aberto / Concluído)", "Status");
  const rId = col_(rh, "ID");
  const rDt = col_(rh, "Detalhes");

  const futures=[], done=[], resgOpen=[], resgOk=[];

  for (let i = 1; i < ld.length; i++) {
    const arq = String(ld[i][iA]||"").trim(); if (!arq) continue;
    const dtRaw = iDP != null ? ld[i][iDP] : "";
    const dt    = dtRaw instanceof Date ? dtRaw : (dtRaw ? new Date(dtRaw) : null);
    if (dataIni && dt && dt < dataIni) continue;
    if (dataFim && dt && dt > dataFim) continue;

    const id   = getOrCreateId_(shLanc, i+1, iId);
    const s    = normalizeKey_(ld[i][iS]);
    const entry = {
      id, arquiteto:arq,
      cliente:     String(ld[i][iC]  ||"").trim(),
      data:        formatDate_(iDP != null ? ld[i][iDP] : (iDF != null ? ld[i][iDF] : "")),
      pontos:      toNumber_(ld[i][iP]),
      previsao:    formatDate_(iDL != null ? ld[i][iDL] : ""),
      liberacao:   formatDate_(iDL != null ? ld[i][iDL] : ""),
      vendaInterna:iVI != null ? String(ld[i][iVI]||"").trim() : "",
      observacao:  iOb != null ? String(ld[i][iOb]||"").trim() : ""
    };

    if      (s === normalizeKey_(CFG.STATUS_PENDENTE)) futures.push(entry);
    else if (s === normalizeKey_(CFG.STATUS_LIBERADO))  done.push(entry);
  }

  for (let i = 1; i < rd.length; i++) {
    const arq = String(rd[i][rA]||"").trim(); if (!arq) continue;
    const dtRaw = rD != null ? rd[i][rD] : "";
    const dt    = dtRaw instanceof Date ? dtRaw : (dtRaw ? new Date(dtRaw) : null);
    if (dataIni && dt && dt < dataIni) continue;
    if (dataFim && dt && dt > dataFim) continue;

    const id = getOrCreateId_(shResg, i+1, rId);
    const s  = normalizeKey_(rd[i][rS]);
    const entry = {
      id, arquiteto:arq,
      pontos:    toNumber_(rd[i][rP]),
      dataPedido:formatDate_(rD  != null ? rd[i][rD]  : ""),
      detalhes:  rDt != null ? String(rd[i][rDt]||"").trim() : ""
    };

    if      (s === normalizeKey_(CFG.RESGATE_ABERTO))   resgOpen.push(entry);
    else if (s === normalizeKey_(CFG.RESGATE_CONCLUIDO) ||
             s === normalizeKey_("CONCLUIDO"))           resgOk.push(entry);
  }

  const tP = futures.reduce((a,b)=>a+b.pontos,0);
  const tL = done.reduce((a,b)=>a+b.pontos,0);
  const tA = resgOpen.reduce((a,b)=>a+b.pontos,0);
  const tR = resgOk.reduce((a,b)=>a+b.pontos,0);

  return { ok:true, futures, done, resgOpen, resgOk,
    summary:{ totalPendente:tP, totalLiberado:tL, totalResgateAberto:tA, totalResgatado:tR,
              totalSaldo:Math.max(0,tL-tR-tA) }
  };
}

/* =========================================================
   AÇÕES — ARQUITETO
   ========================================================= */
function solicitarResgate(token, pontosSolicitados, detalhes, catalogoId) {
  const user = getUserFromToken_(token);
  if (user.funcao !== "ARQUITETO") throw new Error("Acesso negado.");

  pontosSolicitados = toNumber_(pontosSolicitados);
  if (!pontosSolicitados || pontosSolicitados <= 0) throw new Error("Informe os pontos para resgate.");

  const painel = getPainel(token);
  if (pontosSolicitados > painel.resumo.saldoDisponivel)
    throw new Error(`Saldo insuficiente. Disponível: ${painel.resumo.saldoDisponivel} pontos.`);

  ensureExtraColumns_();

  const ss      = SpreadsheetApp.getActive();
  const sh      = ss.getSheetByName(CFG.SHEET_RESGATE);
  const headers = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0];
  const h       = mapHeaders_(headers);

  const iA = col_(h, "Arquiteto");
  const iP = col_(h, "Pontos Solicitados", "Pontos");
  const iD = col_(h, "Data do Pedido", "Data");
  const iS = col_(h, "Status (Em Aberto / Concluido)", "Status (Em Aberto / Concluído)", "Status");
  const iId= col_(h, "ID");
  const iDt= col_(h, "Detalhes");
  const iCI= col_(h, "Catalogo ID");

  const id  = Utilities.getUuid();
  const row = new Array(headers.length).fill("");
  row[iA] = user.nome; row[iP] = pontosSolicitados; row[iS] = CFG.RESGATE_ABERTO;
  if (iD  != null) row[iD]  = new Date();
  if (iId != null) row[iId] = id;
  if (iDt != null) row[iDt] = String(detalhes   || "").trim();
  if (iCI != null) row[iCI] = String(catalogoId || "").trim();

  sh.appendRow(row);
  registrarHistorico_(user.nome, "SOLICITAR RESGATE", `Pontos: ${pontosSolicitados}`, "", "");
  return { ok:true, id, mensagem:"Pedido de resgate enviado! Prazo: 3 a 5 dias." };
}

/* =========================================================
   AÇÕES — ADMIN
   ========================================================= */
function adminLancarPontos(token, payload) {
  const user = getUserFromToken_(token);
  if (user.funcao !== "ADMIN") throw new Error("Acesso negado.");

  ensureExtraColumns_();

  const ss      = SpreadsheetApp.getActive();
  const sh      = ss.getSheetByName(CFG.SHEET_LANC);
  if (!sh) throw new Error("Aba ARQUITETOS não encontrada.");

  const headers = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0];
  const h       = mapHeaders_(headers);

  const iA  = col_(h, "Arquiteto");
  const iC  = col_(h, "Cliente da Obra", "Cliente");
  const iP  = col_(h, "Pontos Gerados", "Pontos");
  const iDL = col_(h, "Data de Liberação", "Data de Liberacao", "Previsão", "Previsao");
  const iS  = col_(h, "Status (Aguardando / Liberado)", "Status");
  const iId = col_(h, "ID");
  const iVI = col_(h, "Venda Interna");
  const iOb = col_(h, "Observacao", "Observação");

  const arq     = String(payload.arquiteto    ||"").trim();
  const cliente = String(payload.cliente      ||"").trim();
  const pontos  = toNumber_(payload.pontos);
  const venda   = String(payload.vendaInterna ||"").trim();
  const obs     = String(payload.observacao   ||"").trim();
  const prev    = payload.dataLiberacao ? new Date(payload.dataLiberacao) : "";

  if (!arq)    throw new Error("Informe o arquiteto.");
  if (!cliente)throw new Error("Informe o cliente/obra.");
  if (pontos<=0)throw new Error("Informe os pontos.");

  const id  = Utilities.getUuid();
  const row = new Array(headers.length).fill("");
  row[iA] = arq; row[iC] = cliente; row[iP] = pontos; row[iS] = CFG.STATUS_PENDENTE;
  if (iDL != null && prev) row[iDL] = prev;
  if (iVI != null)         row[iVI] = venda;
  if (iId != null)         row[iId] = id;
  if (iOb != null)         row[iOb] = obs;

  sh.appendRow(row);
  registrarHistorico_(user.nome, "LANÇAR PONTOS",
    `Arquiteto: ${arq} | Cliente: ${cliente} | Pontos: ${pontos}`, "", "");
  return { ok:true, id, mensagem:"Pontos lançados com sucesso!" };
}

function adminEditarLancamento(token, lancId, payload) {
  const user = getUserFromToken_(token);
  if (user.funcao !== "ADMIN") throw new Error("Acesso negado.");

  ensureExtraColumns_();
  const ss   = SpreadsheetApp.getActive();
  const sh   = ss.getSheetByName(CFG.SHEET_LANC);
  const data = sh.getDataRange().getValues();
  const h    = mapHeaders_(data[0]);

  const iId = col_(h, "ID");
  const iC  = col_(h, "Cliente da Obra", "Cliente");
  const iP  = col_(h, "Pontos Gerados", "Pontos");
  const iDL = col_(h, "Data de Liberação", "Data de Liberacao", "Previsão", "Previsao");
  const iVI = col_(h, "Venda Interna");
  const iOb = col_(h, "Observacao", "Observação");

  const target = findRowById_(data, iId, lancId);
  if (!target) throw new Error("Lançamento não encontrado.");
  const rn = target.rowNumber;

  if (payload.cliente      !== undefined && iC  != null) sh.getRange(rn, iC  +1).setValue(String(payload.cliente||"").trim());
  if (payload.pontos       !== undefined && iP  != null) { const p=toNumber_(payload.pontos); if(p<=0) throw new Error("Pontos > 0."); sh.getRange(rn, iP+1).setValue(p); }
  if (payload.dataLiberacao!== undefined && iDL != null) sh.getRange(rn, iDL +1).setValue(payload.dataLiberacao ? new Date(payload.dataLiberacao) : "");
  if (payload.vendaInterna !== undefined && iVI != null) sh.getRange(rn, iVI +1).setValue(String(payload.vendaInterna||"").trim());
  if (payload.observacao   !== undefined && iOb != null) sh.getRange(rn, iOb +1).setValue(String(payload.observacao||"").trim());

  registrarHistorico_(user.nome, "EDITAR LANÇAMENTO", `ID: ${lancId}`, "", "");
  return { ok:true, mensagem:"Lançamento atualizado!" };
}

function adminExcluirLancamento(token, lancId) {
  const user = getUserFromToken_(token);
  if (user.funcao !== "ADMIN") throw new Error("Acesso negado.");

  const sh   = SpreadsheetApp.getActive().getSheetByName(CFG.SHEET_LANC);
  const data = sh.getDataRange().getValues();
  const h    = mapHeaders_(data[0]);
  const row  = findRowById_(data, col_(h,"ID"), lancId);
  if (!row) throw new Error("Lançamento não encontrado.");
  sh.deleteRow(row.rowNumber);
  registrarHistorico_(user.nome, "EXCLUIR LANÇAMENTO", `ID: ${lancId}`, "", "");
  return { ok:true };
}

function adminLiberarPontos(token, lancId) {
  const user = getUserFromToken_(token);
  if (user.funcao !== "ADMIN") throw new Error("Acesso negado.");

  ensureExtraColumns_();
  const sh   = SpreadsheetApp.getActive().getSheetByName(CFG.SHEET_LANC);
  const data = sh.getDataRange().getValues();
  const h    = mapHeaders_(data[0]);
  const iId  = col_(h, "ID");
  const iS   = col_(h, "Status (Aguardando / Liberado)", "Status");
  const iDL  = col_(h, "Data de Liberação", "Data de Liberacao", "Previsão", "Previsao");
  const row  = findRowById_(data, iId, lancId);
  if (!row) throw new Error("Lançamento não encontrado.");

  sh.getRange(row.rowNumber, iS+1).setValue(CFG.STATUS_LIBERADO);
  if (iDL != null && !sh.getRange(row.rowNumber, iDL+1).getValue())
    sh.getRange(row.rowNumber, iDL+1).setValue(new Date());

  registrarHistorico_(user.nome, "LIBERAR PONTOS", `ID: ${lancId}`, "", "");
  return { ok:true };
}

function adminConcluirResgate(token, resgateId) {
  const user = getUserFromToken_(token);
  if (user.funcao !== "ADMIN") throw new Error("Acesso negado.");

  ensureExtraColumns_();
  const sh   = SpreadsheetApp.getActive().getSheetByName(CFG.SHEET_RESGATE);
  const data = sh.getDataRange().getValues();
  const h    = mapHeaders_(data[0]);
  const iId  = col_(h, "ID");
  const iS   = col_(h, "Status (Em Aberto / Concluido)", "Status (Em Aberto / Concluído)", "Status");
  const row  = findRowById_(data, iId, resgateId);
  if (!row) throw new Error("Resgate não encontrado.");

  sh.getRange(row.rowNumber, iS+1).setValue(CFG.RESGATE_CONCLUIDO);
  registrarHistorico_(user.nome, "CONCLUIR RESGATE", `ID: ${resgateId}`, "", "");
  return { ok:true };
}

function adminAtualizarPrevisao(token, lancId, novaData) {
  const user = getUserFromToken_(token);
  if (user.funcao !== "ADMIN") throw new Error("Acesso negado.");

  ensureExtraColumns_();
  const sh   = SpreadsheetApp.getActive().getSheetByName(CFG.SHEET_LANC);
  const data = sh.getDataRange().getValues();
  const h    = mapHeaders_(data[0]);
  const iId  = col_(h, "ID");
  const iDL  = col_(h, "Data de Liberação", "Data de Liberacao", "Previsão", "Previsao");
  const row  = findRowById_(data, iId, lancId);
  if (!row) throw new Error("Lançamento não encontrado.");

  sh.getRange(row.rowNumber, iDL+1).setValue(new Date(novaData));
  registrarHistorico_(user.nome, "ATUALIZAR PREVISÃO", `ID: ${lancId}`, "", "");
  return { ok:true };
}

/* =========================================================
   HELPERS
   ========================================================= */
function ensureUsuariosExtraColumns_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(CFG.SHEET_USUARIOS);
  if (sh) ensureHeaders_(sh, CFG.EXTRA_USUARIOS_HEADERS);
}

function ensureExtraColumns_() {
  const ss = SpreadsheetApp.getActive();
  const shL = ss.getSheetByName(CFG.SHEET_LANC);
  if (shL) ensureHeaders_(shL, CFG.EXTRA_LANC_HEADERS);
  const shR = ss.getSheetByName(CFG.SHEET_RESGATE);
  if (shR) ensureHeaders_(shR, CFG.EXTRA_RESGATE_HEADERS);
}

function ensureHeaders_(sheet, required) {
  const lastCol = sheet.getLastColumn();
  const hRange  = sheet.getRange(1,1,1,Math.max(1,lastCol));
  const header  = hRange.getValues()[0];
  const existing= header.map(h=>normalizeKey_(h));
  let changed   = false;
  required.forEach(h => { if (!existing.includes(normalizeKey_(h))) { header.push(h); changed=true; } });
  if (changed) sheet.getRange(1,1,1,header.length).setValues([header]);
}

function mapHeaders_(row) {
  const map={};
  for (let i=0;i<row.length;i++) {
    const k=normalizeKey_(row[i]); if (!k) continue; map[k]=i;
  }
  return map;
}

function col_(map, ...candidates) {
  for (const c of candidates) { const k=normalizeKey_(c); if (k in map) return map[k]; }
  return null;
}

function normalizeKey_(s) {
  return String(s||"").trim().toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"");
}

function toNumber_(v) {
  if (v===null||v===undefined||v==="") return 0;
  if (typeof v==="number") return v;
  const n=parseFloat(String(v).replace(/[^\d.,-]/g,"").replace(/\./g,"").replace(",","."));
  return isNaN(n)?0:n;
}

function formatDate_(v) {
  if (!v) return "";
  const d = (v instanceof Date) ? v : new Date(v);
  if (isNaN(d.getTime())) return "";
  return Utilities.formatDate(d, Session.getScriptTimeZone(), "dd/MM/yyyy");
}

function getOrCreateId_(sheet, rowNumber, idxId) {
  if (idxId==null) return "";
  const cell = sheet.getRange(rowNumber, idxId+1);
  let id = String(cell.getValue()||"").trim();
  if (!id) { id=Utilities.getUuid(); cell.setValue(id); }
  return id;
}

function findRowById_(data, idxId, id) {
  id = String(id||"").trim();
  if (!id) return null;
  for (let i=1;i<data.length;i++) {
    if (String(data[i][idxId]||"").trim()===id) return { rowNumber:i+1, row:data[i] };
  }
  return null;
}
