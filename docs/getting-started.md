# Getting started

This guide takes you from signing in to a workspace that shows your stack: connect a provider, read the timeline and the dashboard, get an alert before a bill surprises you, and publish a number you are proud of. Each step names the buttons and headings exactly as StackDash shows them.

## 1. Sign in

Open your StackDash site and select **Sign in**, then **Continue with GitHub**, and approve StackDash on GitHub. Sign-up is invite only for now: sign in with the GitHub account whose primary email was invited. Any other account is refused with "This GitHub account's email has not been invited to StackDash. Ask for an invite, then try again."

You land on the **Timeline** of your personal workspace. The navigation along the top of every workspace page holds **Timeline**, **Dashboard**, **Connections**, **Alerts**, **Projects**, and **Settings**.

Under the **Timeline** heading, **Set up this workspace** lists four steps: **Connect a provider**, **Choose where alerts go**, **Connect your assistant**, and **Share a badge**. Each step says **To do** or **Done** from what the workspace already has, and links to the page that completes it, for example **Go to Connections**. Every step needs the owner or admin role, so a viewer sees why in place of each link. A viewer also sees neither **To do** nor **Done** on **Connect your assistant**, because only owners and admins can see API keys. Select **Hide checklist** to hide it for yourself; it stays hidden after a reload, and every other member still sees it until they hide it too. Once hidden, it cannot be shown again.

## 2. Explore with sample data

A new workspace has nothing to show yet, so the timeline says **No activity yet**. On a site that simulates providers (only a local install with `STACKDASH_SIMULATE_PROVIDERS=1`, never a production deployment), owners and admins of a workspace with no connections also see **Explore with sample data**. Select it to connect every simulated provider to this workspace with this week's made-up history. The timeline opens with **Sample data added**, and everything that data shows is labeled **Simulated**.

When you are done looking around, open each simulated connection from **Connections** and select **Delete connection and history**. A site that simulates providers simulates every provider, so real providers connect only after the person who runs the site removes `STACKDASH_SIMULATE_PROVIDERS` and restarts StackDash. Skip this step if your site does not offer the button.

## 3. Connect your first provider

Only owners and admins of a workspace connect providers. Every member sees what is connected.

1. Open **Connections**. Under **Add a provider**, each card lists the **Data collected** and says whether the provider asks for read access only.
2. Select **Connect** and the provider's name, for example **Connect Vercel**. The next page lists the **Permissions** the provider will ask you to grant and the **Data collected**. A provider that has no read-only permission for that data asks you to tick **I understand StackDash gets full access to my** account first.
3. Select **Continue to** the provider, for example **Continue to Vercel**, and approve StackDash on the provider's own consent screen.
4. Back in StackDash, you land on the new connection's page, which says the provider is connected, for example **Vercel connected**, and links to **Open the timeline**. The connection is also listed under **Connected providers** on **Connections**. Its first sync is queued at once; until it finishes, the timeline says **Events are on their way**.

A card that says **Not set up on this instance** belongs to a provider the person who runs your site has not registered yet. Each provider has its own page in these docs, for example [Vercel](providers/vercel.md), with what StackDash reads, what each permission allows, and what is verified or estimated. [Connect providers](connect-providers.md) lists what each provider needs before it connects, and what to do when a connection needs attention.

## 4. Read the timeline and the dashboard

The **Timeline** is the live feed of your stack: deploys, payments, sync failures, alerts, and daily summaries, newest first. New events appear without a reload. To find events by title, type in the search box above the feed and select **Search**. Select a severity such as **Critical** beside it, or open **Filters** to narrow by event type, date range, provider, project, or account. Each active filter shows as a chip below **Filters**, for example **Provider GitHub**: select a chip to remove only that filter. The sentence beside **Filters** says how many events you see out of how many match across all pages, for example **Showing 50 of 60 events**. Beside the title, each provider with events in view shows its logo, its name, and how many of its events match; select it to show only that provider, and select it again to show every provider. On a narrow screen the provider name is left out and the logo and count remain.

Events sit under a heading for each London day (**Today**, **Yesterday**, or the weekday and date), which stays at the top of the screen as you scroll. A line runs down the feed through each event's provider logo: it shows the order events happened in, newest first, not that one event caused the next. Each event's London time, in hours and minutes, sits to its left on a wide screen and above it on a narrow one; point at a time to see its date and whether it is GMT or BST. Success, warning, and critical events have their severity written beside their title, and ordinary events have no label, so the ones that need attention stand out. Identical events in a row share one entry: select **Show the** count, for example **Show the 3 events**, to list each one with its own time.

Select an event's title to open **Event details**: its provider, severity, type, source account, London time, exact timestamp in UTC, and full text, with a link such as **View in Vercel** when the provider gives one. The details open as a panel on the right of a wide screen and fill a narrow one. **Newer event** and **Older event** step through the events on the page you are on. **Copy event link** copies a link that opens the same event later, even once it has moved off the page or no longer matches your filters. Only members of the workspace can open it. Under **Related events**, **Show only this event type**, **Show only this account** (for an event that has one), and **Show events around this time** (the hour before and after it) show the timeline with that one filter, in place of any you had: Back returns to the event. Press Escape, select **Close event**, or on a wide screen click the timeline beside the panel, to return to the timeline where you left it, with any expanded events still expanded.

Above the feed, **Activity overview** counts every event that matches your filters, across all pages, in up to 12 bars, one per period of time. Without a date range the bars span your matching events; with one they span the whole range, so quiet periods show as empty bars. Critical events fill the bottom of each bar in red and warnings sit above them in amber, so a burst of failures stands out. When any bar holds them, the line below the bars names the two colors. Point at a bar or move keyboard focus to it to see how many events it holds, how many of those are critical or warnings, and the period it covers, printed below the bars. Select a bar to show only the events from that period: the feed and the provider counts beside the title narrow to it, while the bars keep counting every event that matches your other filters, so you can pick another bar. The sentence below the bars names the selected period, how many events it holds, and how many of those are critical or warnings. The address in your browser keeps the selection, so you can share it, and **Clear time selection** removes it and keeps your other filters. Bar times are London time and say GMT or BST. The bars work with the keyboard, and on a narrow screen the chart scrolls sideways.

The **Dashboard** adds up spend, usage, and allowances across every connected provider:

- The headline at the top compares **This week** or **This month** with the same days of the period before: **Revenue**, **Spend**, **Revenue minus spend**, **Signups**, **Cost per signup**, and **Deploys**. A figure StackDash cannot work out says why instead of showing a number.
- Below it, each provider has a card with its spend, its allowances and how much of each is left, and when they reset. **Verified spend** is the amount the provider reported. **Estimated spend** is calculated by StackDash from the provider's published prices, and says so.

## 5. Set an alert

Open **Alerts**. Owners and admins manage rules; every member sees what fired.

- **Suggested alerts** appears when a connected provider reports allowances that no rule watches yet. Select **Add these alerts** to be alerted at 75%, 90%, and 100% of each of that provider's allowances.
- To write your own rule, go to **Add an alert rule**. Under **Alert when**, choose **Usage reaches a percentage of a provider allowance**, **Spend reaches an amount**, or **Spend reaches a percentage of your budget** (add the budget under **Add a budget** first), set the threshold, and select **Add alert rule**.

A rule raises an alert at most once per billing period. Alerts that fired are listed under **Triggered alerts** at the top of the page, where owners and admins acknowledge them.

## 6. Publish a metric

Spend, budgets, and alerts are never public. Usage metrics such as deployments or GitHub stars can be, one project at a time, and only after an owner or admin publishes them.

1. Open **Projects**, enter a **Project name**, and select **Create project**. A project groups accounts from different providers into one product.
2. Assign accounts to it: open **Connections**, select a connection, and under **Accounts** choose the project in **Project for** that account, then select **Save project**.
3. Back on **Projects**, select **Public metrics** for the project. Under **Metrics from your connected providers**, choose the **Rounding** and **Timing** of a metric and select **Publish**.
4. A published metric gets a badge and a card to share. To give the project a public page, select **Turn on the project page**.

How each public number is counted is in [Public metrics](architecture/public-metrics.md).

## Next steps

- Connect the rest of your stack: [Connect providers](connect-providers.md).
- Read your workspace from your own scripts with the [REST API](api.md).
- Ask an AI assistant about your workspace through the [MCP server](mcp.md).
- Run StackDash yourself: [Self-host StackDash](operations/self-hosting.md).
- See what is coming next: [Roadmap](roadmap.md).
