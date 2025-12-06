# Pricing Review - Standalone App

Jednoduchá aplikácia na prezeranie a editovanie cenotvorby produktov.

## 🚀 Nasadenie na Railway

### 1. Vytvor nový projekt na Railway
- Choď na [railway.app](https://railway.app)
- Klikni "New Project" → "Deploy from GitHub repo" alebo "Empty Project"

### 2. Pridaj environment variables
V Railway dashboard → Settings → Variables:

```
DB_URL=libsql://business-flow-ai-zonabxxx.aws-eu-west-1.turso.io
DB_TOKEN=eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9...
SHARE_TOKEN=tvoj-tajny-token-123
```

### 3. Deploy
Ak používaš GitHub:
- Pushni tento folder do nového repozitára
- Pripoj repo k Railway

Ak uploduješ manuálne:
- Použij Railway CLI: `railway up`

### 4. Prístup
Po deployi dostaneš URL ako:
`https://pricing-review-production.up.railway.app`

Zdieľaj tento link komukoľvek kto má editovať časy.

## 🔐 Bezpečnosť

- `SHARE_TOKEN` chráni API pred neautorizovaným prístupom
- Všetky zmeny sa logujú do `product_pricing_feedback` tabuľky
- Zmeny sa aplikujú priamo do `service_checklists`

## 📁 Štruktúra

```
pricing-review-standalone/
├── server.js          # Express server
├── package.json       # Dependencies
├── public/
│   └── index.html     # Frontend aplikácia
└── README.md
```

## 🛠️ Lokálny vývoj

```bash
cd pricing-review-standalone
npm install
DB_URL=... DB_TOKEN=... npm start
```

Otvor http://localhost:3000

