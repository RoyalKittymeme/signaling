import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { URL } from 'url';

// Almacenamiento en memoria de conexiones activas
const activeConnections = new Map();
const PORT = process.env.PORT || 10000;

// Crear servidor HTTP
const server = createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  
  // Configurar CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }
  
  if (parsedUrl.pathname === '/health' || parsedUrl.pathname === '/') {
    // Endpoint de salud
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'plethorix-signaling-server',
      version: '1.0.0',
      activeConnections: activeConnections.size,
      onlineNodes: Array.from(activeConnections.keys()),
      timestamp: Date.now()
    }));
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Endpoint not found' }));
  }
});

// Crear servidor WebSocket
const wss = new WebSocketServer({ 
  server,
  clientTracking: true
});

console.log(`🚀 Servidor Plethorix-P2P iniciando en puerto ${PORT}...`);

wss.on('connection', function connection(ws, req) {
  // Generar ID único Plethorix-xxxxxxxx
  const nodeId = generatePlethorixId();
  const clientIp = req.socket.remoteAddress;
  
  console.log(`🔗 Nuevo nodo conectado: ${nodeId} desde ${clientIp}`);
  
  const nodeInfo = {
    id: nodeId,
    ws: ws,
    ip: clientIp,
    connectedAt: new Date(),
    lastSeen: Date.now(),
    isBootstrap: false,
    bootstrapScore: 0,
    knownPeers: new Set()
  };
  
  // Guardar conexión
  activeConnections.set(nodeId, nodeInfo);
  
  // Enviar mensaje de bienvenida con ID asignado
  ws.send(JSON.stringify({
    type: 'welcome',
    nodeId: nodeId,
    timestamp: Date.now(),
    message: 'Bienvenido a Plethorix-P2P',
    totalNodes: activeConnections.size
  }));
  
  // Notificar a otros nodos sobre nuevo miembro (excepto al nuevo)
  broadcastToAll({
    type: 'node-joined',
    nodeId: nodeId,
    timestamp: Date.now(),
    totalNodes: activeConnections.size
  }, nodeId);
  
  // Enviar lista de nodos activos al nuevo nodo
  const activeNodes = Array.from(activeConnections.keys())
    .filter(id => id !== nodeId);
    
  if (activeNodes.length > 0) {
    setTimeout(() => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({
          type: 'peer-list',
          peers: activeNodes,
          timestamp: Date.now()
        }));
        console.log(`📋 Lista de ${activeNodes.length} pares enviada a ${nodeId}`);
      }
    }, 1000);
  }
  
  ws.on('message', function message(rawData) {
    try {
      const data = rawData.toString();
      const message = JSON.parse(data);
      
      nodeInfo.lastSeen = Date.now();
      
      console.log(`📨 Mensaje de ${nodeId}: ${message.type}`);
      handleClientMessage(nodeId, message, ws);
      
    } catch (error) {
      console.error(`❌ Error procesando mensaje de ${nodeId}:`, error);
      
      // Enviar error al cliente
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({
          type: 'error',
          message: 'Invalid message format',
          timestamp: Date.now()
        }));
      }
    }
  });
  
  ws.on('close', function close() {
    console.log(`🔌 Nodo desconectado: ${nodeId}`);
    activeConnections.delete(nodeId);
    
    // Notificar a otros nodos
    broadcastToAll({
      type: 'node-left', 
      nodeId: nodeId,
      timestamp: Date.now(),
      totalNodes: activeConnections.size
    });
  });
  
  ws.on('error', function error(err) {
    console.error(`❌ Error en conexión ${nodeId}:`, err);
  });
  
  // Enviar ping cada 30 segundos para mantener conexión activa
  const pingInterval = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      ws.ping();
    } else {
      clearInterval(pingInterval);
    }
  }, 30000);
  
  ws.on('pong', () => {
    nodeInfo.lastSeen = Date.now();
  });
});

function generatePlethorixId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let randomId = '';
  for (let i = 0; i < 8; i++) {
    randomId += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `Plethorix-${randomId}`;
}

function handleClientMessage(nodeId, message, ws) {
  switch (message.type) {
    case 'signal':
      // Reenviar señal WebRTC a nodo destino
      if (message.to && activeConnections.has(message.to)) {
        const targetNode = activeConnections.get(message.to);
        
        if (targetNode.ws.readyState === targetNode.ws.OPEN) {
          targetNode.ws.send(JSON.stringify({
            type: 'signal',
            from: nodeId,
            signal: message.signal,
            timestamp: Date.now()
          }));
          
          console.log(`📤 Señal WebRTC de ${nodeId} → ${message.to}`);
        }
      } else {
        // Notificar que el destino no está disponible
        ws.send(JSON.stringify({
          type: 'error',
          message: `Target node ${message.to} not found`,
          timestamp: Date.now()
        }));
      }
      break;
      
    case 'broadcast':
      // Broadcast a todos los nodos
      broadcastToAll({
        type: 'broadcast',
        from: nodeId,
        data: message.data,
        timestamp: Date.now()
      }, nodeId);
      break;
      
    case 'bootstrap-announcement':
      // Anunciar como bootstrap
      const nodeInfo = activeConnections.get(nodeId);
      nodeInfo.isBootstrap = true;
      nodeInfo.bootstrapScore = message.score || calculateBootstrapScore(nodeInfo);
      
      console.log(`🏗️ ${nodeId} se declara como Bootstrap (score: ${nodeInfo.bootstrapScore})`);
      
      broadcastToAll({
        type: 'bootstrap-announcement',
        bootstrapId: nodeId,
        bootstrapScore: nodeInfo.bootstrapScore,
        timestamp: Date.now()
      }, nodeId);
      break;
      
    case 'peer-discovery':
      // Solicitar descubrimiento de pares
      const activeNodes = Array.from(activeConnections.keys())
        .filter(id => id !== nodeId);
      
      ws.send(JSON.stringify({
        type: 'peer-list',
        peers: activeNodes,
        timestamp: Date.now()
      }));
      break;
      
    case 'ping':
      // Responder ping
      ws.send(JSON.stringify({
        type: 'pong',
        timestamp: Date.now(),
        original: message.timestamp
      }));
      break;
      
    default:
      console.log(`❓ Mensaje desconocido de ${nodeId}:`, message.type);
  }
}

function broadcastToAll(message, excludeNodeId = null) {
  let delivered = 0;
  
  activeConnections.forEach((nodeInfo, nodeId) => {
    if (nodeId !== excludeNodeId && nodeInfo.ws.readyState === 1) { // 1 = OPEN
      nodeInfo.ws.send(JSON.stringify(message));
      delivered++;
    }
  });
  
  console.log(`📢 Broadcast ${message.type} enviado a ${delivered} nodos`);
}

function calculateBootstrapScore(nodeInfo) {
  let score = 0;
  score += nodeInfo.knownPeers.size * 5;
  score += Math.floor((Date.now() - nodeInfo.connectedAt) / 60000); // 1 punto por minuto
  return Math.min(score, 100); // Máximo 100 puntos
}

// Limpiar conexiones inactivas cada minuto
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  
  activeConnections.forEach((nodeInfo, nodeId) => {
    if (now - nodeInfo.lastSeen > 60000) { // 1 minuto sin actividad
      activeConnections.delete(nodeId);
      cleaned++;
      
      console.log(`🧹 Limpiando nodo inactivo: ${nodeId}`);
      
      // Notificar a otros nodos
      broadcastToAll({
        type: 'node-left',
        nodeId: nodeId,
        reason: 'timeout',
        timestamp: now,
        totalNodes: activeConnections.size
      });
    }
  });
  
  if (cleaned > 0) {
    console.log(`🧹 Limpiados ${cleaned} nodos inactivos. Activos: ${activeConnections.size}`);
  }
}, 60000);

// Manejar cierre graceful
process.on('SIGTERM', () => {
  console.log('🛑 Recibido SIGTERM, cerrando servidor...');
  
  // Notificar a todos los clientes
  broadcastToAll({
    type: 'server-shutdown',
    message: 'Server is shutting down',
    timestamp: Date.now()
  });
  
  // Cerrar todas las conexiones
  activeConnections.forEach((nodeInfo) => {
    nodeInfo.ws.close();
  });
  
  server.close(() => {
    console.log('✅ Servidor cerrado gracefulmente');
    process.exit(0);
  });
});

// Iniciar servidor
server.listen(PORT, () => {
  console.log(`🎯 Servidor Plethorix-P2P ejecutándose en puerto ${PORT}`);
  console.log(`🌐 WebSocket: ws://localhost:${PORT}`);
  console.log(`❤️  Health: http://localhost:${PORT}/health`);
});