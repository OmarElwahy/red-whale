import subprocess
import json
import sys

def run_tool(target):
    nodes = []
    edges = []

    # 1. Create the parent node (e.g., the target domain)
    nodes.append({
        "id": target,
        "label": target,
        "type": "domain",
        "tool": "input"
    })

    # 2. Teammate runs their assigned tool (Example: subfinder)
    cmd = ["subfinder", "-d", target, "-silent"]
    result = subprocess.run(cmd, capture_output=True, text=True)

    # 3. Teammate loops over output and formats it into your exact structure
    for line in result.stdout.splitlines():
        sub = line.strip()
        if sub:
            nodes.append({
                "id": sub,
                "label": sub,
                "type": "subdomain",
                "tool": "subfinder"
            })
            edges.append({
                "source": target,
                "target": sub,
                "label": "has_subdomain"
            })

    # 4. Save to unified JSON file
    output = {"nodes": nodes, "edges": edges}
    with open("output.json", "w") as f:
        json.dump(output, f, indent=2)

if __name__ == "__main__":
    target_input = sys.argv[1] # e.g., python3 run_subdomains.py example.com
    run_tool(target_input)