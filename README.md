# Proxysys

High-performance transparent proxy gateway with static header injection and MCP support.

## Overview

Proxysys is a specialized Node.js proxy server designed for routing, header injection, cookie session handling, dynamic identity transformation, and Model Context Protocol (MCP) integrations.

## Features

- **Transparent Proxy**: Secure upstream forwarding with custom headers and SSL support.
- **Cookie & Session Management**: Automated cookie capture, merging, and masking via `/cookies` and `/cookies/refresh`.
- **Dynamic Identity**: Session-based header isolation and injection.
- **MCP Connector**: Built-in Model Context Protocol connector for routing context and tools.
- **Intelligence Proxy & Routing**: Route table lookup and request/response transformers.

## Getting Started

### Prerequisites

- Node.js (v18+)
- npm

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/nogravityai/Proxysys.git
   cd Proxysys
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Setup environment & cookies:
   - Copy `cookies.example.json` to `cookies.json`:
     ```bash
     cp cookies.example.json cookies.json
     ```
   - Update `cookies.json` with valid session credentials.

4. Run the proxy server:
   ```bash
   npm start
   ```

   For development with hot reload:
   ```bash
   npm run dev
   ```

## Configuration

Configuration settings are centralized in `config.js`:
- `proxy_port`: Port for the local proxy (default: 8080)
- `target_host`: Target host URL
- `cookies_file`: Path to the cookie file (`./cookies.json`)
- `mcp_endpoint`: MCP endpoint route

## License

MIT
