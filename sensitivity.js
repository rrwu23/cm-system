/**
 * td id="out-last-price"
 * td id="out-target-price"
 * 
 */

const APIBASE = "https://api.kidsfunbank.ca"
const params = new URLSearchParams(window.location.search);
const companyName = params.get("company_name"); // "Tencent"
const input_t = document.getElementById("in-target-eps");

input_t.addEventListener("change", () => {
    refresh();
});
const input_tp = document.getElementById("in-target-pe");

input_tp.addEventListener("change", () => {
    refresh();
});
const input_b = document.getElementById("in-bad-eps");

input_b.addEventListener("change", () => {
    refresh();
});
const input_bp = document.getElementById("in-bad-pe");

input_bp.addEventListener("change", () => {
    refresh();
});

const input_w = document.getElementById("in-win-prob");

input_w.addEventListener("change", () => {
    refresh();
});

async function init(){

    const symbol_res = await fetch(
        `${APIBASE}/get_symbol_by_name?name=${params.get("company_name")}`
    );

    if (!symbol_res.ok) {
        throw new Error(`Request failed: ${symbol_res.status}`);
    }

    const symbol_json = await symbol_res.json();
    const symbol = symbol_json.symbol

    const response = await fetch(
        `${APIBASE}/companies/` + encodeURIComponent(companyName)
    );
    console.log("final url: ", response.url)

    if (!response.ok) {
        throw new Error(`Request failed: ${response.status}`);
    }

    const json = await response.json();
    console.log(json)
    const data=json.numerical_values
    console.log("data: ", data)
    let target_price = data.target_price
    let target_eps = target_price/20
    let target_pe = 20
    let bad_price = data.bad_price
    let bad_eps = 10
    let bad_pe = bad_price / bad_eps
    let rank = data.rank
    current_price = Math.round(data.current_price*100)/100
    console.log("input field values: ", target_eps, target_pe, bad_eps, bad_pe)
    document.getElementById("out-target-price").textContent = target_price
    document.getElementById("out-bad-price").textContent = bad_price
    document.getElementById("in-target-eps").value = target_eps
    document.getElementById("in-target-pe").value = target_pe
    document.getElementById("in-bad-eps").value = bad_eps
    document.getElementById("in-bad-pe").value = bad_pe
    document.getElementById("out-last-price").textContent = current_price
    document.getElementById("in-win-prob").value = String(data.winning_probability*100) + "%" 
    for (const element of document.getElementsByClassName("rank-pill")) {
        element.textContent = rank
        element.dataset.grade = rank
    }
    next_rank_display_flow(symbol, target_price, bad_price, data.winning_probability, data.rank)
}

function parse_win_prob(win_prob){
    if (win_prob.slice(-1) == "%"){ 
        let remaining = win_prob.slice(0, -1);
        let win_prob_num = Number(remaining)/100
        return win_prob_num
    }
    else {
        return Number(win_prob)/100
    }
}

async function refresh(){
    let target_eps = document.getElementById("in-target-eps").value
    let target_pe = document.getElementById("in-target-pe").value
    let target=target_eps*target_pe
    let bad_eps = document.getElementById("in-bad-eps").value
    let bad_pe = document.getElementById("in-bad-pe").value
    let bad = bad_pe * bad_eps
    let win_prob = document.getElementById("in-win-prob").value

    const response = await fetch(
        `${APIBASE}/get_symbol_by_name?name=${params.get("company_name")}`
    );

    if (!response.ok) {
        throw new Error(`Request failed: ${response.status}`);
    }

    const json = await response.json();
    const symbol = json.symbol

    const rank_res = await fetch(
        `${APIBASE}/calcrank?target_price=${target}&bad_price=${bad}&symbol=${symbol}&win_prob=${parse_win_prob(win_prob)}`
    );

    if (!rank_res.ok) {
        throw new Error(`Request failed: ${response.status}`);
    }
    
    //updating output cells
    const data = await rank_res.json();
    for (const element of document.getElementsByClassName("rank-pill")){
        element.textContent = data.rank
        element.dataset.grade = data.rank
    }

    document.getElementById("out-target-price").textContent = target
    document.getElementById("out-bad-price").textContent = bad
    
    //next rank price workflow
    //query next_rank endpoint on additional rank = 1 and = 2
    //if next_rank1 = current_rank, 0, else crit. same for rank=2

    next_rank_display_flow(symbol, target, bad, parse_win_prob(win_prob), data.rank)

}

async function next_rank_display_flow(symbol, target, bad, win_prob, rank){
    const rank1 = await fetch(
        `${APIBASE}/next_ranks_price/?num=1&symbol=${symbol}&target=${target}&bad=${bad}&win_prob=${win_prob}&cur_rank=${rank}`
    );

    console.log("final url: ", rank1.url)

    if (!rank1.ok) {
        throw new Error(`Request failed: ${rank1.status}`);
    }

    const rank1_json = await rank1.json();
    let rank1_price = rank1_json.next_price
    
    const rank2 = await fetch(
        `${APIBASE}/next_ranks_price/?num=2&symbol=${symbol}&target=${target}&bad=${bad}&win_prob=${win_prob}&cur_rank=${rank}`
    );

     console.log("final url: ", rank1.url)

    if (!rank2.ok) {
        throw new Error(`Request failed: ${rank1.status}`);
    }

    const rank2_json = await rank2.json();

    let rank2_price = rank2_json.next_price

    if (rank1_json.rank == rank2_json.rank){
        rank2_price=0
    }

    let next_rank_display = String(rank2_price) + " ~ " + String(rank1_price)

    document.getElementById("out-next-rank-price").textContent = next_rank_display
}

init()