// index.js (final) - Mantiene diseño: banner + 4 botones de categorías
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionsBitField,
  ChannelType,
  AttachmentBuilder
} = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

// ----------------- Config / archivos -----------------
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const MENU_CHANNEL_ID = process.env.MENU_CHANNEL_ID;
const TICKETS_CATEGORY_ID = process.env.TICKET_CATEGORY_ID;
const LOGS_CHANNEL_ID = process.env.LOGS_CHANNEL_ID;
const BANNER_URL = process.env.BANNER_URL || '';
const STAFF_ROLE_ID = process.env.STAFF_ROLE_ID || null;

if (!DISCORD_TOKEN) console.error('❌ ADVERTENCIA: DISCORD_TOKEN no definido en .env');
if (!MENU_CHANNEL_ID) console.error('❌ ADVERTENCIA: MENU_CHANNEL_ID no definido en .env');
if (!LOGS_CHANNEL_ID) console.error('❌ ADVERTENCIA: LOGS_CHANNEL_ID no definido en .env');

const COUNTER_FILE = path.join(__dirname, 'ticketCounter.json');
const TICKETS_FILE = path.join(__dirname, 'ticketsData.json');

// Crear archivos si no existen
if (!fs.existsSync(COUNTER_FILE)) fs.writeFileSync(COUNTER_FILE, JSON.stringify({ count: 0 }, null, 2));
if (!fs.existsSync(TICKETS_FILE)) fs.writeFileSync(TICKETS_FILE, JSON.stringify({}, null, 2));

let ticketCounter = JSON.parse(fs.readFileSync(COUNTER_FILE, 'utf8')).count || 0;
let ticketsData = JSON.parse(fs.readFileSync(TICKETS_FILE, 'utf8')) || {};

// Guardado
function saveCounter() {
  fs.writeFileSync(COUNTER_FILE, JSON.stringify({ count: ticketCounter }, null, 2));
}
function saveTicketsData() {
  fs.writeFileSync(TICKETS_FILE, JSON.stringify(ticketsData, null, 2));
}

// Map de botones -> nombre corto de categoría (usado en nombre de canal)
const CATEGORY_MAP = {
  ticket_soporte: 'soporte',
  ticket_tienda: 'tienda',
  ticket_bug: 'bugs',
  ticket_jugadores: 'jugadores'
};

// ----------------- Util: paginación para obtener todos los mensajes -----------------
async function fetchAllMessages(channel) {
  let all = [];
  let lastId;
  while (true) {
    const options = { limit: 100 };
    if (lastId) options.before = lastId;
    const fetched = await channel.messages.fetch(options);
    if (!fetched || fetched.size === 0) break;
    all = all.concat(Array.from(fetched.values()));
    lastId = fetched.last().id;
    // si solo llegó una tanda y es la misma, rompe (seguridad)
    if (fetched.size < 100) break;
  }
  return all.reverse(); // ordenar cronológicamente
}

// ----------------- Util: comprobar staff -----------------
function isStaff(member) {
  if (!member) return false;
  if (STAFF_ROLE_ID && member.roles.cache.has(STAFF_ROLE_ID)) return true;
  return member.permissions.has(PermissionsBitField.Flags.ManageChannels);
}

// ----------------- Ready: enviar banner + menú (sin duplicados) -----------------
client.once('ready', async () => {
  console.log(`✅ Ooopa iniciado como ${client.user.tag}`);

  if (!MENU_CHANNEL_ID) {
    console.error('❌ MENU_CHANNEL_ID no configurado en .env — no se enviará el menú.');
    return;
  }

  const menuChannel = await client.channels.fetch(MENU_CHANNEL_ID).catch(() => null);
  if (!menuChannel) {
    console.error('❌ No se pudo obtener el canal del menú (MENU_CHANNEL_ID). Revisa permisos y el ID.');
    return;
  }

  // Borrar mensajes antiguos enviados por el bot en el canal del menú (solo los del bot)
  const recent = await menuChannel.messages.fetch({ limit: 50 }).catch(() => null);
  if (recent) {
    const botMsgs = recent.filter(m => m.author?.id === client.user.id);
    for (const m of botMsgs.values()) {
      try { await m.delete(); } catch {}
    }
  }

  // Enviar banner (arriba) si existe
  if (BANNER_URL && BANNER_URL.trim() !== '') {
    try {
      await menuChannel.send({ files: [BANNER_URL] });
    } catch (err) {
      console.warn('⚠ No se pudo enviar el banner (revisa BANNER_URL):', err.message);
    }
  }

  // Embed + 4 botones (diseño intacto)
  const embed = new EmbedBuilder()
    .setTitle('🎟 Sistema de Tickets')
    .setDescription('📌 Elija la categoría de su queja. Si no está seguro de cuál elegir, no dude en preguntar en #soporte-publico')
    .setColor(0xFFD700);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket_soporte').setLabel('🆘 Soporte de Usuario').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('ticket_tienda').setLabel('🛒 Tienda').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('ticket_bug').setLabel('🐞 Reporte de Bugs').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('ticket_jugadores').setLabel('🚫 Reporte de Jugadores').setStyle(ButtonStyle.Secondary)
  );

  await menuChannel.send({ embeds: [embed], components: [row] }).catch(err => console.error('Error enviando menú:', err));
  console.log('📨 Menú enviado correctamente.');
});

// ----------------- Interacciones (botones) -----------------
client.on('interactionCreate', async (interaction) => {
  try {
    if (!interaction.isButton()) return;
    const guild = interaction.guild;
    if (!guild) return interaction.reply({ content: '❌ Interacción fuera de servidor.', ephemeral: true });

    // ---------- Crear ticket (botones de categorías) ----------
    if (interaction.customId.startsWith('ticket_')) {
      const categoryShort = CATEGORY_MAP[interaction.customId];
      if (!categoryShort) return interaction.reply({ content: '❌ Categoría inválida.', ephemeral: true });

      // Evitar múltiples tickets abiertos por el mismo usuario (útil)
      const alreadyOpen = Object.values(ticketsData).some(t => t.userId === interaction.user.id && t.status === 'open');
      if (alreadyOpen) return interaction.reply({ content: '⚠️ Ya tienes un ticket abierto.', ephemeral: true });

      // contador global persistente
      ticketCounter++;
      saveCounter();

      // Nombre del canal: incluye categoría y número (ej: ticket-tienda-005)
      const channelName = `ticket-${categoryShort}-${String(ticketCounter).padStart(3, '0')}`;

      // Determinar parent (categoría). Si no existe o no es categoría, creamos sin parent (pero avisamos en consola)
      let parentOption = undefined;
      if (TICKETS_CATEGORY_ID) {
        const fetchedParent = await guild.channels.fetch(TICKETS_CATEGORY_ID).catch(() => null);
        if (fetchedParent && fetchedParent.type === ChannelType.GuildCategory) parentOption = fetchedParent.id;
        else console.warn('⚠ TICKETS_CATEGORY_ID no es una categoría válida o no se encontró. El ticket se creará sin parent.');
      } else {
        console.warn('⚠ TICKETS_CATEGORY_ID no configurado; el ticket se creará sin parent.');
      }

      // Permisos: nadie (everyone) no ve, usuario sí, staff opcional sí
      const permissionOverwrites = [
        { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
        { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }
      ];
      if (STAFF_ROLE_ID) permissionOverwrites.push({ id: STAFF_ROLE_ID, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] });

      // Crear canal
      const createData = {
        name: channelName,
        type: ChannelType.GuildText,
        permissionOverwrites
      };
      if (parentOption) createData.parent = parentOption;

      const ticketChannel = await guild.channels.create(createData).catch(err => {
        console.error('Error creando canal de ticket:', err);
        return null;
      });
      if (!ticketChannel) return interaction.reply({ content: '❌ No se pudo crear el canal del ticket (permiso o categoría).', ephemeral: true });

      // Guardar en persistencia
      ticketsData[ticketChannel.id] = {
        userId: interaction.user.id,
        number: ticketCounter,
        category: categoryShort,
        status: 'open',
        createdAt: Date.now()
      };
      saveTicketsData();

      // Establecer topic con info (opcional, ayuda debugging)
      try { await ticketChannel.setTopic(`ticket|user:${interaction.user.id}|num:${ticketCounter}`); } catch {}

      // Mensaje inicial dentro del ticket con un único botón 'Cerrar'
      const ticketEmbed = new EmbedBuilder()
        .setTitle(`📂 Ticket: ${categoryShort}`)
        .setDescription(`Hola <@${interaction.user.id}>, describe tu problema y el staff te atenderá. \n\n**Número:** ${ticketCounter}`)
        .setColor(0x00AA00)
        .setTimestamp();

      const initialRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('close_ticket').setLabel('🔒 Cerrar').setStyle(ButtonStyle.Danger)
      );

      await ticketChannel.send({ content: `<@${interaction.user.id}>`, embeds: [ticketEmbed], components: [initialRow] }).catch(() => {});

      await interaction.reply({ content: `✅ Tu ticket fue creado: ${ticketChannel}`, ephemeral: true });
      return;
    }

    // ---------- A partir de aquí: botones dentro de un ticket ----------
    const chanId = interaction.channelId;
    const ticketInfo = ticketsData[chanId];
    if (!ticketInfo) return interaction.reply({ content: '❌ Este canal no está registrado como ticket.', ephemeral: true });

    // Cerrar ticket
    if (interaction.customId === 'close_ticket') {
      // Permisos: solo creador o staff
      const member = await guild.members.fetch(interaction.user.id).catch(() => null);
      if (interaction.user.id !== ticketInfo.userId && !isStaff(member)) {
        return interaction.reply({ content: '❌ Solo el creador o el staff pueden cerrar el ticket.', ephemeral: true });
      }

      // Quitar permiso de ver al usuario original
      await interaction.channel.permissionOverwrites.edit(ticketInfo.userId, { ViewChannel: false }).catch(() => {});
      ticketInfo.status = 'closed';
      saveTicketsData();

      // Reemplazar botones: Reabrir + Archivar (habilitados)
      const closedRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('reopen_ticket').setLabel('🔓 Reabrir').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('archive_ticket').setLabel('📦 Archivar').setStyle(ButtonStyle.Secondary)
      );

      // update message that triggered interaction (the message with the buttons)
      try {
        await interaction.update({ content: interaction.message.content, components: [closedRow] });
      } catch {
        await interaction.reply({ content: '✅ Ticket cerrado.', ephemeral: true });
      }
      return;
    }

    // Reabrir ticket
    if (interaction.customId === 'reopen_ticket') {
      const member = await guild.members.fetch(interaction.user.id).catch(() => null);
      if (interaction.user.id !== ticketInfo.userId && !isStaff(member)) {
        return interaction.reply({ content: '❌ Solo el creador o el staff pueden reabrir el ticket.', ephemeral: true });
      }

      // Restaurar permisos
      await interaction.channel.permissionOverwrites.edit(ticketInfo.userId, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true
      }).catch(() => {});

      ticketInfo.status = 'open';
      saveTicketsData();

      // volver a botón inicial (Cerrar)
      const reopenRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('close_ticket').setLabel('🔒 Cerrar').setStyle(ButtonStyle.Danger)
      );

      try {
        await interaction.update({ content: interaction.message.content, components: [reopenRow] });
      } catch {
        await interaction.reply({ content: '♻️ Ticket reabierto.', ephemeral: true });
      }
      return;
    }

    // Archivar ticket (solo si está cerrado)
    if (interaction.customId === 'archive_ticket') {
      const member = await guild.members.fetch(interaction.user.id).catch(() => null);
      if (interaction.user.id !== ticketInfo.userId && !isStaff(member)) {
        return interaction.reply({ content: '❌ Solo el creador o el staff pueden archivar el ticket.', ephemeral: true });
      }

      if (ticketInfo.status !== 'closed') {
        return interaction.reply({ content: '⚠️ Debes cerrar el ticket antes de archivar.', ephemeral: true });
      }

      // Obtener TODO el historial (paginación robusta)
      const allMessages = await fetchAllMessages(interaction.channel).catch(err => {
        console.error('Error fetchAllMessages:', err);
        return [];
      });

      // Formatear líneas con timestamp y autor; incluir attachments si existen
      const lines = allMessages.map(m => {
        const time = (m.createdAt ? m.createdAt.toISOString().replace('T', ' ').split('.')[0] : '');
        const author = m.author ? m.author.tag : 'Desconocido';
        let content = m.content || '';
        // incluir URLs de attachments (si las hay)
        if (m.attachments && m.attachments.size > 0) {
          const urls = m.attachments.map(a => a.url).join(' ');
          content = content ? `${content} [Adjuntos: ${urls}]` : `[Adjuntos: ${urls}]`;
        }
        return `[${time}] ${author}: ${content || '(sin texto)'}`;
      });

      const text = lines.join('\n') || 'Sin mensajes.';

      // Nombre de archivo con categoría y número para claridad
      const fileName = `ticket-${ticketInfo.category}-${ticketInfo.number}.txt`;
      try {
        fs.writeFileSync(fileName, text, 'utf8');
      } catch (err) {
        console.error('Error escribiendo archivo .txt:', err);
        return interaction.reply({ content: '❌ Error al generar el archivo de log.', ephemeral: true });
      }

      // Embed para logs
      const logEmbed = new EmbedBuilder()
        .setTitle('📁 Ticket Archivado')
        .setDescription(`**Canal:** ${interaction.channel.name}\n**Categoría:** ${ticketInfo.category}\n**Número:** ${ticketInfo.number}\n**Abierto por:** <@${ticketInfo.userId}>\n**Archivado por:** <@${interaction.user.id}>`)
        .setColor(0x3498DB)
        .setTimestamp();

      // Enviar archivo al canal de logs
      const logsChannel = await client.channels.fetch(LOGS_CHANNEL_ID).catch(() => null);
      if (!logsChannel) {
        try { fs.unlinkSync(fileName); } catch {}
        return interaction.reply({ content: '❌ Canal de logs no encontrado. Revisa LOGS_CHANNEL_ID en .env.', ephemeral: true });
      }

      try {
        await logsChannel.send({ embeds: [logEmbed], files: [fileName] });
      } catch (err) {
        console.error('Error enviando log al canal de logs:', err);
        // intentar borrar archivo local y seguir
      }

      // limpiar
      try { fs.unlinkSync(fileName); } catch (e) {}

      // eliminar del registro y borrar canal
      delete ticketsData[interaction.channel.id];
      saveTicketsData();
      await interaction.channel.delete().catch(() => {});

      return;
    }

  } catch (err) {
    console.error('Error en interactionCreate:', err);
    try { if (interaction && !interaction.replied) await interaction.reply({ content: '❌ Ocurrió un error interno.', ephemeral: true }); } catch {}
  }
});

// ----------------- Iniciar sesión -----------------
client.login(DISCORD_TOKEN).catch(err => console.error('Error iniciando sesión del bot:', err));
