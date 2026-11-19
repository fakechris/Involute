# Projects, milestones, and delivery

## Organize work

1. Open **Projects** and select the team. Use **New project** if you need a place for related work. If the project tracks code, associate its repository so deliveries can link back to it.
2. Open **Milestones** (`/milestones`). In **Milestones (Work Graph)**, use **New milestone**, enter its **Title**, and select the **Project** and **Location**. Use **Outcome** to say what should be true when it is done. **Cycles (Legacy)** is separate from work-graph milestones.
3. When creating issues, choose the project's milestone in **Location** or use **No milestone** to put the issue directly under the project. Put actual dependencies in **Relations**, not in the nesting alone.

For access outside the team, see [project sharing](../project-sharing.md).

## Explore the graph

Open **Graph** and **Choose a project**. Use **Outline** to see how work is nested, **Dependencies** to inspect blocking links, or **Timeline** to see work over time. Start in Outline if you are looking for a parent or milestone, and switch to Dependencies when the question is what is holding up delivery.

## Read delivery latency and burndown

1. Open **Delivery latency** (`/delivery`). Choose a team, set the project scope and select a **Delivery window**. Read the displayed inclusive UTC dates before comparing results.
2. Open the **Lead time**, **Cycle time**, or **Review wait** tile to inspect its completed samples. P50 is the median and P90 is the 90th percentile; check the sample count and **Low coverage** warning before drawing conclusions. Open work is separate from the completed samples. Run wall-clock is not actual time spent by a person or agent.
3. In **Burndown**, choose a **Burndown milestone**. Scope counts committed, non-canceled issues; remaining also excludes completed issues. Shaded days and **History gaps** indicate unknown history, not zero work. The chart counts issues, not effort or a completion forecast.
4. With a repository project selected, click **Open in timeline** to inspect the same calendar window in Graph. There is no project timeline link for the all-projects scope or the no-repository selection.

See `deliveryLatency` and `milestoneBurndown` in the [API query reference](../api.md#graphql-queries) for sample and history definitions.
