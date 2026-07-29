import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const USERNAME = "Laleyendadelnorte";
const GRAPHQL_URL = "https://api.github.com/graphql";
const PUBLIC_CALENDAR_URL = `https://github.com/users/${USERNAME}/contributions`;

const WEEKS = 53;
const DAYS = 7;
const CELL_SIZE = 13;
const CELL_GAP = 4;
const CELL_STEP = CELL_SIZE + CELL_GAP;
const GRID_X = 52;
const GRID_Y = 84;
const GRID_WIDTH = WEEKS * CELL_SIZE + (WEEKS - 1) * CELL_GAP;
const GRID_HEIGHT = DAYS * CELL_SIZE + (DAYS - 1) * CELL_GAP;
const SVG_WIDTH = 1024;
const SVG_HEIGHT = 252;

const LEVELS = {
  NONE: 0,
  FIRST_QUARTILE: 1,
  SECOND_QUARTILE: 2,
  THIRD_QUARTILE: 3,
  FOURTH_QUARTILE: 4,
};

const THEMES = {
  dark: {
    background: "#0d1117",
    border: "#30363d",
    innerBorder: "#21262d",
    text: "#e6edf3",
    muted: "#8b949e",
    cells: ["#161b22", "#0e4429", "#006d32", "#26a641", "#39d353"],
    accent: "#58a6ff",
    accentSoft: "#388bfd",
    jetStroke: "#cae8ff",
  },
  light: {
    background: "#ffffff",
    border: "#d0d7de",
    innerBorder: "#eaeef2",
    text: "#1f2328",
    muted: "#656d76",
    cells: ["#ebedf0", "#9be9a8", "#40c463", "#30a14e", "#216e39"],
    accent: "#0969da",
    accentSoft: "#54aeff",
    jetStroke: "#0550ae",
  },
};

const GRAPHQL_QUERY = `
  query ContributionCalendar($login: String!, $from: DateTime!, $to: DateTime!) {
    user(login: $login) {
      contributionsCollection(from: $from, to: $to) {
        contributionCalendar {
          totalContributions
          weeks {
            contributionDays {
              contributionCount
              contributionLevel
              date
            }
          }
        }
      }
    }
  }
`;

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function addUtcDays(date, amount) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + amount);
  return result;
}

function startOfUtcDay(date) {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

function startOfUtcWeek(date) {
  const day = startOfUtcDay(date);
  return addUtcDays(day, -day.getUTCDay());
}

function oneYearAgo(date) {
  const result = new Date(date);
  result.setUTCFullYear(result.getUTCFullYear() - 1);
  return result;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function decodeHtml(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&nbsp;", " ");
}

function getAttribute(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return match?.[1] ?? null;
}

async function fetchGraphqlCalendar(token, from, to) {
  const response = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": `${USERNAME}-heatmap-generator`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({
      query: GRAPHQL_QUERY,
      variables: {
        login: USERNAME,
        from: from.toISOString(),
        to: to.toISOString(),
      },
    }),
  });

  const payload = await response.json();

  if (!response.ok || payload.errors) {
    const detail =
      payload.errors?.map((error) => error.message).join("; ") ??
      `${response.status} ${response.statusText}`;
    throw new Error(`GitHub GraphQL request failed: ${detail}`);
  }

  const calendar = payload.data?.user?.contributionsCollection?.contributionCalendar;
  if (!calendar) {
    throw new Error(`GitHub user "${USERNAME}" was not found.`);
  }

  return calendar.weeks.flatMap((week) =>
    week.contributionDays.map((day) => ({
      count: day.contributionCount,
      date: day.date,
      level: LEVELS[day.contributionLevel] ?? 0,
    })),
  );
}

function parsePublicCalendar(html) {
  const countsByCellId = new Map();
  const tooltipPattern = /<tool-tip\b[^>]*>[\s\S]*?<\/tool-tip>/g;

  for (const match of html.matchAll(tooltipPattern)) {
    const tooltip = match[0];
    const openingTag = tooltip.slice(0, tooltip.indexOf(">") + 1);
    const cellId = getAttribute(openingTag, "for");
    const text = decodeHtml(
      tooltip
        .replace(/^<tool-tip\b[^>]*>/, "")
        .replace(/<\/tool-tip>$/, "")
        .replace(/<[^>]+>/g, ""),
    ).trim();
    const countMatch = text.match(/([\d,]+)\s+contributions?\b/i);

    if (cellId) {
      countsByCellId.set(
        cellId,
        countMatch ? Number(countMatch[1].replaceAll(",", "")) : 0,
      );
    }
  }

  const days = [];
  const cellPattern =
    /<td\b[^>]*class="[^"]*\bContributionCalendar-day\b[^"]*"[^>]*>/g;

  for (const match of html.matchAll(cellPattern)) {
    const cell = match[0];
    const date = getAttribute(cell, "data-date");
    const level = Number(getAttribute(cell, "data-level"));
    const cellId = getAttribute(cell, "id");

    if (date && Number.isInteger(level)) {
      days.push({
        count: countsByCellId.get(cellId) ?? 0,
        date,
        level: Math.max(0, Math.min(4, level)),
      });
    }
  }

  if (days.length < 350) {
    throw new Error(
      `GitHub public calendar returned only ${days.length} contribution days.`,
    );
  }

  return days;
}

async function fetchPublicCalendar() {
  const response = await fetch(PUBLIC_CALENDAR_URL, {
    headers: {
      Accept: "text/html",
      "User-Agent": `${USERNAME}-heatmap-generator`,
    },
  });

  if (!response.ok) {
    throw new Error(
      `GitHub public calendar request failed: ${response.status} ${response.statusText}`,
    );
  }

  return parsePublicCalendar(await response.text());
}

async function getContributionDays(from, to) {
  const token = process.env.GITHUB_TOKEN?.trim();

  if (token) {
    try {
      const days = await fetchGraphqlCalendar(token, from, to);
      return { days, source: "GitHub GraphQL API" };
    } catch (error) {
      console.warn(`${error.message} Falling back to GitHub's public calendar.`);
    }
  } else {
    console.warn(
      "GITHUB_TOKEN is not set. Using GitHub's public calendar for this local run.",
    );
  }

  return {
    days: await fetchPublicCalendar(),
    source: "GitHub public contribution calendar",
  };
}

function normalizeCalendar(days, today) {
  const byDate = new Map(days.map((day) => [day.date, day]));
  const firstWeek = addUtcDays(startOfUtcWeek(today), -(WEEKS - 1) * DAYS);
  const weeks = [];

  for (let weekIndex = 0; weekIndex < WEEKS; weekIndex += 1) {
    const week = [];

    for (let dayIndex = 0; dayIndex < DAYS; dayIndex += 1) {
      const date = addUtcDays(firstWeek, weekIndex * DAYS + dayIndex);
      const dateString = isoDate(date);
      const contribution = byDate.get(dateString);

      week.push({
        count: contribution?.count ?? 0,
        date: dateString,
        future: date > today,
        level: contribution?.level ?? 0,
      });
    }

    weeks.push(week);
  }

  return { firstWeek, weeks };
}

function buildFlightPath() {
  const left = GRID_X - 10;
  const right = GRID_X + GRID_WIDTH + 10;
  const rowY = Array.from(
    { length: DAYS },
    (_, index) => GRID_Y + index * CELL_STEP + CELL_SIZE / 2,
  );
  const parts = [`M ${left} ${rowY[0]}`];

  for (let row = 0; row < DAYS; row += 1) {
    const movingRight = row % 2 === 0;
    const edge = movingRight ? right : left;
    parts.push(`L ${edge} ${rowY[row]}`);

    if (row < DAYS - 1) {
      const outside = edge + (movingRight ? 24 : -24);
      parts.push(
        `C ${outside} ${rowY[row]} ${outside} ${rowY[row + 1]} ${edge} ${rowY[row + 1]}`,
      );
    }
  }

  const returnY = GRID_Y + GRID_HEIGHT + 18;
  parts.push(
    `C ${right + 28} ${rowY.at(-1)} ${right + 28} ${returnY} ${right} ${returnY}`,
    `L ${left} ${returnY}`,
    `C ${left - 28} ${returnY} ${left - 28} ${rowY[0]} ${left} ${rowY[0]}`,
  );

  return parts.join(" ");
}

function buildMonthLabels(firstWeek, theme) {
  const monthNames = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const labels = [];
  let previousMonth = -1;

  for (let week = 0; week < WEEKS; week += 1) {
    const date = addUtcDays(firstWeek, week * DAYS);
    const month = date.getUTCMonth();

    if (month !== previousMonth) {
      labels.push(
        `<text x="${GRID_X + week * CELL_STEP}" y="${GRID_Y - 13}" fill="${theme.muted}" font-size="10">${monthNames[month]}</text>`,
      );
      previousMonth = month;
    }
  }

  return labels.join("\n    ");
}

function buildCells(weeks, theme) {
  return weeks
    .flatMap((week, weekIndex) =>
      week.map((day, dayIndex) => {
        const x = GRID_X + weekIndex * CELL_STEP;
        const y = GRID_Y + dayIndex * CELL_STEP;
        const opacity = day.future ? 0.42 : 1;
        const noun = day.count === 1 ? "contribution" : "contributions";

        return `<rect x="${x}" y="${y}" width="${CELL_SIZE}" height="${CELL_SIZE}" rx="3" fill="${theme.cells[day.level]}" opacity="${opacity}"><title>${day.count} ${noun} on ${escapeXml(day.date)}</title></rect>`;
      }),
    )
    .join("\n    ");
}

function buildLegend(theme) {
  const startX = 817;
  const cellStart = startX + 34;
  const cells = theme.cells
    .map(
      (color, index) =>
        `<rect x="${cellStart + index * 16}" y="225" width="11" height="11" rx="2.5" fill="${color}"/>`,
    )
    .join("\n      ");

  return `<text x="${startX}" y="234" fill="${theme.muted}" font-size="9">Less</text>
      ${cells}
      <text x="${cellStart + 86}" y="234" fill="${theme.muted}" font-size="9">More</text>`;
}

function renderSvg({ firstWeek, themeName, today, total, weeks }) {
  const theme = THEMES[themeName];
  const flightPath = buildFlightPath();
  const totalLabel = new Intl.NumberFormat("en-US").format(total);

  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- Generated by generate.mjs. Do not edit manually. -->
<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 ${SVG_WIDTH} ${SVG_HEIGHT}" role="img" aria-labelledby="title desc" preserveAspectRatio="xMidYMid meet">
  <title id="title">${escapeXml(USERNAME)} GitHub contribution flight</title>
  <desc id="desc">An animated jet flies across ${totalLabel} GitHub contributions from the last 53 weeks.</desc>
  <defs>
    <linearGradient id="tail-gradient" x1="-44" y1="0" x2="-5" y2="0" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${theme.accentSoft}" stop-opacity="0"/>
      <stop offset="1" stop-color="${theme.accent}" stop-opacity="0.82"/>
    </linearGradient>
    <filter id="jet-glow" x="-120%" y="-120%" width="340%" height="340%">
      <feGaussianBlur stdDeviation="2.4" result="blur"/>
      <feFlood flood-color="${theme.accent}" flood-opacity="0.42" result="color"/>
      <feComposite in="color" in2="blur" operator="in" result="glow"/>
      <feMerge>
        <feMergeNode in="glow"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  </defs>

  <rect x="4" y="4" width="${SVG_WIDTH - 8}" height="${SVG_HEIGHT - 8}" rx="18" fill="${theme.background}" stroke="${theme.border}"/>
  <rect x="12" y="12" width="${SVG_WIDTH - 24}" height="${SVG_HEIGHT - 24}" rx="13" fill="none" stroke="${theme.innerBorder}"/>

  <g font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif">
    <text x="52" y="36" fill="${theme.text}" font-size="17" font-weight="650">${escapeXml(USERNAME)}</text>
    <text x="52" y="55" fill="${theme.muted}" font-size="9.5" letter-spacing="1.8">CONTRIBUTION FLIGHT · LAST 53 WEEKS</text>
    <text x="972" y="36" fill="${theme.muted}" font-size="9.5" text-anchor="end" letter-spacing="0.8">UPDATED ${isoDate(today)}</text>

    ${buildMonthLabels(firstWeek, theme)}

    <g aria-label="Contribution calendar">
    ${buildCells(weeks, theme)}
    </g>

    <path d="${flightPath}" fill="none" stroke="${theme.accentSoft}" stroke-width="0.8" stroke-dasharray="2 13" stroke-linecap="round" opacity="0.13">
      <animate attributeName="stroke-dashoffset" from="0" to="-60" dur="5s" repeatCount="indefinite"/>
    </path>

    <g>
      <path d="M -45 0 L -7 0" fill="none" stroke="url(#tail-gradient)" stroke-width="3" stroke-linecap="round" stroke-dasharray="4 5">
        <animate attributeName="stroke-dashoffset" from="0" to="18" dur="1.25s" repeatCount="indefinite"/>
        <animate attributeName="opacity" values="0.32;0.72;0.32" dur="1.8s" repeatCount="indefinite"/>
      </path>
      <path d="M -30 0 L -7 0" fill="none" stroke="${theme.accent}" stroke-width="1" stroke-linecap="round" opacity="0.58"/>
      <g filter="url(#jet-glow)">
        <path d="M 17 0 L 4 -3.2 L -2 -12 L -6 -12 L -4 -3.2 L -13 -2 L -17 -6 L -20 -6 L -18 0 L -20 6 L -17 6 L -13 2 L -4 3.2 L -6 12 L -2 12 L 4 3.2 Z" fill="${theme.accent}" stroke="${theme.jetStroke}" stroke-width="0.8" stroke-linejoin="round"/>
        <path d="M 8 -1.2 L 14 0 L 8 1.2 Z" fill="${theme.jetStroke}" opacity="0.9"/>
        <circle cx="-3" cy="0" r="1.45" fill="${theme.jetStroke}">
          <animate attributeName="opacity" values="0.35;1;0.35" dur="1.1s" repeatCount="indefinite"/>
        </circle>
      </g>
      <animateMotion path="${flightPath}" dur="28s" rotate="auto" repeatCount="indefinite"/>
    </g>

    <text x="52" y="234" fill="${theme.text}" font-size="10.5" font-weight="600">${totalLabel} contributions</text>
    <text x="173" y="234" fill="${theme.muted}" font-size="9.5">visible in this 53-week flight window</text>
    ${buildLegend(theme)}
  </g>
</svg>
`;
}

async function main() {
  const now = new Date();
  const today = startOfUtcDay(now);
  const { days, source } = await getContributionDays(oneYearAgo(now), now);
  const { firstWeek, weeks } = normalizeCalendar(days, today);
  const total = weeks
    .flat()
    .filter((day) => !day.future)
    .reduce((sum, day) => sum + day.count, 0);

  await Promise.all(
    Object.keys(THEMES).map((themeName) =>
      writeFile(
        resolve(`${themeName}.svg`),
        renderSvg({ firstWeek, themeName, today, total, weeks }),
        "utf8",
      ),
    ),
  );

  console.log(
    `Generated dark.svg and light.svg with ${total} contributions from ${source}.`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
