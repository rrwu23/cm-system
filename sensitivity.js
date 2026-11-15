/**
 * td id="out-last-price"
 * td id="out-target-price"
 * 
 */

const APIBASE = "api.kidsfunbank.ca"
const params = new URLSearchParams(window.location.search);
const companyName = params.get("company_name"); // "Tencent"


async function init(){
    const params = new URLSearchParams({ name: companyName });

    const response = await fetch(
        `${APIBASE}/get_symbol_by_name?${params}`
    );

    if (!response.ok) {
        throw new Error(`Request failed: ${response.status}`);
    }

    const json = await response.json();
    let target_price = json.target_price
    let target_eps = target_price/20
    let target_pe = 20
    let bad_price = json.bad_price
    let bad_eps = 10
    let bad_pe = bad_price / bad_eps
    let rank = json.rank
    document.getElementById("in-target-eps").textContent = target_eps
    document.getElementById("in-target-pe").textContent = target_pe
    document.getElementById("in-bad-eps").textContent = bad_eps
    document.getElementById("in-bad-pe").textContent = bad_pe
    for (const element of document.getElementsByClassName("rank-pill")) {
        element.textContent = rank
    }
}

async function refresh(){
    let target_eps = document.getElementById("in-target-eps").textContent
    let target_pe = document.getElementById("in-target-pe").textContent
    let target=target_eps*target_pe
    let bad_eps = document.getElementById("in-bad-eps").textContent
    let bad_pe = document.getElementById("in-bad-pe").textContent
    let bad = bad_pe * bad_eps

    const response = await fetch(
        `${APIBASE}/get_symbol_by_name?${params}`
    );

    if (!response.ok) {
        throw new Error(`Request failed: ${response.status}`);
    }

    const json = await response.json();
    const symbol = json.symbol

    const rank_res = await fetch(
        `${APIBASE}/calcrank?target_price=${target}&bad_price=${bad}&symbol=${symbol}`
    );

    if (!rank_res.ok) {
        throw new Error(`Request failed: ${response.status}`);
    }

    const data = await rank_res.json();
    for (const element of document.getElementsByClassName("rank-pill")){
        element.textContent = data.rank
    }
}